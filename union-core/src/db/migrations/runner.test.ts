import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import {
  ADVISORY_LOCK_ID,
  ChecksumMismatchError,
  computeChecksum,
  discoverMigrations,
  DuplicateMigrationIdentityError,
  getResolvedConfig,
  MalformedMigrationIdentityError,
  MissingDatabaseConfigurationError,
  runMigrations
} from './runner.js';

function getTestConfig() {
  const password = process.env.POSTGRES_PASSWORD ?? 'local_f1_5_c1_secret_key';
  return {
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
    database: process.env.POSTGRES_DB ?? 'union',
    user: process.env.POSTGRES_USER ?? 'union_app',
    password,
    migrationsDir: path.resolve(process.cwd(), 'migrations')
  };
}

async function cleanDatabase(config = getTestConfig()) {
  const client = new pg.Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password
  });
  await client.connect();
  try {
    await client.query('DROP TABLE IF EXISTS union_schema_migrations;');
  } finally {
    await client.end();
  }
}

test('TEST 1: Valid first migration applies successfully', async () => {
  const config = getTestConfig();
  await cleanDatabase(config);

  const result = await runMigrations(config);
  assert.equal(result.appliedCount, 1);
  assert.equal(result.alreadyAppliedCount, 0);
  assert.deepEqual(result.migrations, ['0001_migration_foundation.sql']);
});

test('TEST 2: Second execution is idempotent', async () => {
  const config = getTestConfig();

  const secondRun = await runMigrations(config);
  assert.equal(secondRun.appliedCount, 0);
  assert.equal(secondRun.alreadyAppliedCount, 1);
  assert.deepEqual(secondRun.migrations, []);
});

test('TEST 3: Migration history contains correct migration identity', async () => {
  const config = getTestConfig();
  const client = new pg.Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password
  });
  await client.connect();

  try {
    const res = await client.query<{ migration_id: string; filename: string }>(
      'SELECT migration_id, filename FROM union_schema_migrations;'
    );
    assert.equal(res.rows.length, 1);
    assert.equal(res.rows[0].migration_id, '0001');
    assert.equal(res.rows[0].filename, '0001_migration_foundation.sql');
  } finally {
    await client.end();
  }
});

test('TEST 4: Recorded SHA-256 equals actual migration content checksum', async () => {
  const config = getTestConfig();
  const filePath = path.join(config.migrationsDir, '0001_migration_foundation.sql');
  const fileContent = await fs.readFile(filePath, 'utf8');
  const expectedChecksum = computeChecksum(fileContent);

  const client = new pg.Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password
  });
  await client.connect();

  try {
    const res = await client.query<{ checksum: string }>(
      "SELECT checksum FROM union_schema_migrations WHERE migration_id = '0001';"
    );
    assert.equal(res.rows.length, 1);
    assert.equal(res.rows[0].checksum, expectedChecksum);
  } finally {
    await client.end();
  }
});

test('TEST 5: Modify an already-applied migration in test context fails closed', async () => {
  const config = getTestConfig();
  const filePath = path.join(config.migrationsDir, '0001_migration_foundation.sql');
  const originalContent = await fs.readFile(filePath, 'utf8');
  const modifiedContent = originalContent + '\n-- Tampered comment for checksum test\n';

  try {
    // Write tampered content temporarily
    await fs.writeFile(filePath, modifiedContent, 'utf8');

    // Executing migration runner must throw ChecksumMismatchError
    await assert.rejects(
      async () => {
        await runMigrations(config);
      },
      (err: unknown) => {
        assert.ok(err instanceof ChecksumMismatchError);
        assert.ok((err as ChecksumMismatchError).message.includes('Checksum mismatch'));
        return true;
      }
    );
  } finally {
    // Restore original content
    await fs.writeFile(filePath, originalContent, 'utf8');
  }
});

test('TEST 6: Malformed or duplicate migration identity is rejected', async () => {
  const tempDir = await fs.mkdtemp(path.join(process.cwd(), 'temp_migrations_'));

  try {
    // Malformed filename test
    const malformedFile = path.join(tempDir, 'invalid_name.sql');
    await fs.writeFile(malformedFile, 'SELECT 1;', 'utf8');

    await assert.rejects(
      async () => {
        await discoverMigrations(tempDir);
      },
      (err: unknown) => {
        assert.ok(err instanceof MalformedMigrationIdentityError);
        return true;
      }
    );

    // Remove malformed file and create duplicate ID files
    await fs.unlink(malformedFile);
    await fs.writeFile(path.join(tempDir, '0001_first.sql'), 'SELECT 1;', 'utf8');
    await fs.writeFile(path.join(tempDir, '0001_duplicate.sql'), 'SELECT 2;', 'utf8');

    await assert.rejects(
      async () => {
        await discoverMigrations(tempDir);
      },
      (err: unknown) => {
        assert.ok(err instanceof DuplicateMigrationIdentityError);
        return true;
      }
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('TEST 7: Failed migration inside transaction does NOT become recorded', async () => {
  const config = getTestConfig();
  const tempMigrationsDir = await fs.mkdtemp(path.join(process.cwd(), 'temp_failed_mig_'));

  try {
    // Create valid 0001
    const sql0001 = await fs.readFile(
      path.join(config.migrationsDir, '0001_migration_foundation.sql'),
      'utf8'
    );
    await fs.writeFile(path.join(tempMigrationsDir, '0001_migration_foundation.sql'), sql0001, 'utf8');

    // Create invalid 0002 that throws SQL syntax error
    await fs.writeFile(
      path.join(tempMigrationsDir, '0002_broken_sql.sql'),
      'INVALID SQL SYNTAX HERE;',
      'utf8'
    );

    const testConfig = { ...config, migrationsDir: tempMigrationsDir };

    await assert.rejects(async () => {
      await runMigrations(testConfig);
    });

    // Check that 0002 was NOT recorded in union_schema_migrations
    const client = new pg.Client({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password
    });
    await client.connect();

    try {
      const res = await client.query<{ migration_id: string }>(
        "SELECT migration_id FROM union_schema_migrations WHERE migration_id = '0002';"
      );
      assert.equal(res.rows.length, 0);
    } finally {
      await client.end();
    }
  } finally {
    await fs.rm(tempMigrationsDir, { recursive: true, force: true });
  }
});

test('TEST 8: Missing sensitive DB configuration fails closed', () => {
  assert.throws(
    () => {
      getResolvedConfig({ password: '' });
    },
    (err: unknown) => {
      assert.ok(err instanceof MissingDatabaseConfigurationError);
      return true;
    }
  );

  const originalEnvPassword = process.env.POSTGRES_PASSWORD;
  delete process.env.POSTGRES_PASSWORD;

  try {
    assert.throws(
      () => {
        getResolvedConfig({});
      },
      (err: unknown) => {
        assert.ok(err instanceof MissingDatabaseConfigurationError);
        return true;
      }
    );
  } finally {
    if (originalEnvPassword) {
      process.env.POSTGRES_PASSWORD = originalEnvPassword;
    }
  }
});

test('TEST 9: Concurrent runner execution cannot silently double-apply', async () => {
  const config = getTestConfig();

  // Run two concurrent migration calls simultaneously
  const [res1, res2] = await Promise.all([
    runMigrations(config),
    runMigrations(config)
  ]);

  // Total applied across both runners must equal 0 since 0001 is already applied
  assert.equal(res1.appliedCount + res2.appliedCount, 0);
  assert.equal(res1.alreadyAppliedCount, 1);
  assert.equal(res2.alreadyAppliedCount, 1);

  // Lock constant check
  assert.equal(ADVISORY_LOCK_ID, 8641001);
});
