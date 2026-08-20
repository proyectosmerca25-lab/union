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
import { EnvironmentMismatchError, InvalidConfigurationError } from '../../config/config.js';

function getTestConfig() {
  const password = process.env.POSTGRES_PASSWORD ?? 'local_f1_5_c1_secret_key';
  return {
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
    database: process.env.POSTGRES_DB ?? 'union',
    user: process.env.POSTGRES_USER ?? 'union_app',
    password,
    migrationsDir: path.resolve(process.cwd(), 'migrations'),
    env: 'local',
    databaseEnv: 'local'
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

test('TEST F: env=local & databaseEnv=local migration behavior remains PASS', async () => {
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
    await fs.writeFile(filePath, modifiedContent, 'utf8');

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
    await fs.writeFile(filePath, originalContent, 'utf8');
  }
});

test('TEST 6: Malformed or duplicate migration identity is rejected', async () => {
  const tempDir = await fs.mkdtemp(path.join(process.cwd(), 'temp_migrations_'));

  try {
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
    const sql0001 = await fs.readFile(
      path.join(config.migrationsDir, '0001_migration_foundation.sql'),
      'utf8'
    );
    await fs.writeFile(path.join(tempMigrationsDir, '0001_migration_foundation.sql'), sql0001, 'utf8');

    await fs.writeFile(
      path.join(tempMigrationsDir, '0002_broken_sql.sql'),
      'INVALID SQL SYNTAX HERE;',
      'utf8'
    );

    const testConfig = { ...config, migrationsDir: tempMigrationsDir };

    await assert.rejects(async () => {
      await runMigrations(testConfig);
    });

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
      getResolvedConfig({ env: 'local', databaseEnv: 'local', password: '' });
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
        getResolvedConfig({ env: 'local', databaseEnv: 'local' });
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

  const [res1, res2] = await Promise.all([
    runMigrations(config),
    runMigrations(config)
  ]);

  assert.equal(res1.appliedCount + res2.appliedCount, 0);
  assert.equal(res1.alreadyAppliedCount, 1);
  assert.equal(res2.alreadyAppliedCount, 1);
  assert.equal(ADVISORY_LOCK_ID, 8641001);
});

// MANDATORY CORRECTION NEGATIVE TESTS (TEST A - TEST E)

test('TEST A: env missing & databaseEnv=local -> FAIL CLOSED before DB connection', () => {
  const originalUnionEnv = process.env.UNION_ENV;
  delete process.env.UNION_ENV;

  try {
    assert.throws(
      () => {
        getResolvedConfig({ databaseEnv: 'local', password: 'fake' });
      },
      (err: unknown) => {
        assert.ok(err instanceof MissingDatabaseConfigurationError);
        assert.ok((err as MissingDatabaseConfigurationError).message.includes('UNION_ENV is required'));
        return true;
      }
    );
  } finally {
    if (originalUnionEnv) process.env.UNION_ENV = originalUnionEnv;
  }
});

test('TEST B: env=local & databaseEnv missing -> FAIL CLOSED before DB connection', () => {
  const originalDbEnv = process.env.DATABASE_ENV;
  delete process.env.DATABASE_ENV;

  try {
    assert.throws(
      () => {
        getResolvedConfig({ env: 'local', password: 'fake' });
      },
      (err: unknown) => {
        assert.ok(err instanceof MissingDatabaseConfigurationError);
        assert.ok((err as MissingDatabaseConfigurationError).message.includes('DATABASE_ENV is required'));
        return true;
      }
    );
  } finally {
    if (originalDbEnv) process.env.DATABASE_ENV = originalDbEnv;
  }
});

test('TEST C: Both environment identities missing -> FAIL CLOSED, no implicit local/local', () => {
  const originalUnionEnv = process.env.UNION_ENV;
  const originalDbEnv = process.env.DATABASE_ENV;
  delete process.env.UNION_ENV;
  delete process.env.DATABASE_ENV;

  try {
    assert.throws(
      () => {
        getResolvedConfig({ password: 'fake' });
      },
      (err: unknown) => {
        assert.ok(err instanceof MissingDatabaseConfigurationError);
        return true;
      }
    );
  } finally {
    if (originalUnionEnv) process.env.UNION_ENV = originalUnionEnv;
    if (originalDbEnv) process.env.DATABASE_ENV = originalDbEnv;
  }
});

test('TEST D: env=invalid & databaseEnv=invalid -> FAIL CLOSED', () => {
  assert.throws(
    () => {
      getResolvedConfig({ env: 'staging', databaseEnv: 'staging', password: 'fake' });
    },
    (err: unknown) => {
      assert.ok(err instanceof InvalidConfigurationError);
      return true;
    }
  );
});

test('TEST E: env=local & databaseEnv=production -> FAIL CLOSED before DB connection', () => {
  assert.throws(
    () => {
      getResolvedConfig({ env: 'local', databaseEnv: 'production', password: 'fake' });
    },
    (err: unknown) => {
      assert.ok(err instanceof EnvironmentMismatchError);
      return true;
    }
  );
});

// CANONICAL DATABASE_URL TESTS (TEST A - TEST G)

test('TEST A (DATABASE_URL): DATABASE_URL valid & UNION_ENV=production & DATABASE_ENV=production -> config accepted', () => {
  const config = getResolvedConfig({
    env: 'production',
    databaseEnv: 'production',
    connectionString: 'postgresql://postgres:secretpassword@postgres.railway.internal:5432/railway'
  });
  assert.equal(config.env, 'production');
  assert.equal(config.databaseEnv, 'production');
  assert.equal(
    config.connectionString,
    'postgresql://postgres:secretpassword@postgres.railway.internal:5432/railway'
  );
});

test('TEST B (DATABASE_URL): DATABASE_URL valid & environment identity missing -> FAIL CLOSED', () => {
  const origUnionEnv = process.env.UNION_ENV;
  const origDbEnv = process.env.DATABASE_ENV;
  delete process.env.UNION_ENV;
  delete process.env.DATABASE_ENV;

  try {
    assert.throws(
      () => {
        getResolvedConfig({
          connectionString: 'postgresql://postgres:secretpassword@postgres.railway.internal:5432/railway'
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof MissingDatabaseConfigurationError);
        assert.ok((err as MissingDatabaseConfigurationError).message.includes('UNION_ENV is required'));
        return true;
      }
    );
  } finally {
    if (origUnionEnv) process.env.UNION_ENV = origUnionEnv;
    if (origDbEnv) process.env.DATABASE_ENV = origDbEnv;
  }
});

test('TEST C (DATABASE_URL): DATABASE_URL valid & UNION_ENV=production & DATABASE_ENV=local -> FAIL CLOSED', () => {
  assert.throws(
    () => {
      getResolvedConfig({
        env: 'production',
        databaseEnv: 'local',
        connectionString: 'postgresql://postgres:secretpassword@postgres.railway.internal:5432/railway'
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof EnvironmentMismatchError);
      return true;
    }
  );
});

test('TEST D (DATABASE_URL): DATABASE_URL malformed -> FAIL CLOSED', () => {
  const invalidUrls = [
    'not_a_valid_url',
    'mysql://user:pass@localhost:3306/db',
    'postgresql://',
    'postgres://:5432/'
  ];

  for (const invalidUrl of invalidUrls) {
    assert.throws(
      () => {
        getResolvedConfig({
          env: 'production',
          databaseEnv: 'production',
          connectionString: invalidUrl
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof InvalidConfigurationError);
        assert.ok((err as InvalidConfigurationError).message.includes('Invalid DATABASE_URL configuration'));
        return true;
      }
    );
  }
});

test('TEST E (DATABASE_URL): DATABASE_URL absent & alternative DB config incomplete -> FAIL CLOSED', () => {
  const origDbUrl = process.env.DATABASE_URL;
  const origPass = process.env.POSTGRES_PASSWORD;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_PASSWORD;

  try {
    assert.throws(
      () => {
        getResolvedConfig({
          env: 'production',
          databaseEnv: 'production'
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof MissingDatabaseConfigurationError);
        assert.ok((err as MissingDatabaseConfigurationError).message.includes('POSTGRES_PASSWORD is required'));
        return true;
      }
    );
  } finally {
    if (origDbUrl) process.env.DATABASE_URL = origDbUrl;
    if (origPass) process.env.POSTGRES_PASSWORD = origPass;
  }
});

test('TEST G (DATABASE_URL): No DATABASE_URL or password appears in error messages', () => {
  const secretPass = 'super_secret_p@ssw0rd_123!';
  const secretUrl = `postgresql://postgres:${secretPass}@postgres.railway.internal:5432/railway`;

  try {
    getResolvedConfig({
      env: 'production',
      databaseEnv: 'local',
      connectionString: secretUrl
    });
  } catch (err: unknown) {
    if (err instanceof Error) {
      assert.ok(!err.message.includes(secretPass));
      assert.ok(!err.message.includes(secretUrl));
    }
  }
});

// STRICT MIGRATION DISCOVERY TESTS

test('STRICT MIGRATION FILENAME CONTRACT: Permissive or malformed filenames fail closed', async () => {
  const tempDir = await fs.mkdtemp(path.join(process.cwd(), 'temp_strict_mig_'));

  try {
    const invalidFilenames = [
      '0001_bad space.sql',
      '0001_bad!char.sql',
      '0001_bad.extra.sql',
      'invalid_prefix.sql'
    ];

    for (const badName of invalidFilenames) {
      const filePath = path.join(tempDir, badName);
      await fs.writeFile(filePath, 'SELECT 1;', 'utf8');

      await assert.rejects(
        async () => {
          await discoverMigrations(tempDir);
        },
        (err: unknown) => {
          assert.ok(err instanceof MalformedMigrationIdentityError);
          assert.ok((err as MalformedMigrationIdentityError).message.includes("Expected '0001_name.sql'"));
          return true;
        }
      );

      await fs.unlink(filePath);
    }

    // Valid strict filenames must pass
    const validFilenames = ['0001_foundation.sql', '0002_user-accounts.sql', '0003_app_data.sql'];
    for (const validName of validFilenames) {
      await fs.writeFile(path.join(tempDir, validName), 'SELECT 1;', 'utf8');
    }

    const discovered = await discoverMigrations(tempDir);
    assert.equal(discovered.length, 3);
    assert.equal(discovered[0].id, '0001');
    assert.equal(discovered[1].id, '0002');
    assert.equal(discovered[2].id, '0003');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});


