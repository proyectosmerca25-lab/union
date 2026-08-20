import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EnvironmentMismatchError,
  getSafeConfigSummary,
  InvalidConfigurationError,
  loadConfig,
  MissingConfigurationError
} from './config.js';
import { runMigrations } from '../db/migrations/runner.js';

const FAKE_TEST_SECRET = 'postgresql://union_app:FAKE_TEST_SECRET_KEY_12345@localhost:5432/union';

test('TEST 1: local/local environment pair = PASS', () => {
  const config = loadConfig({
    UNION_ENV: 'local',
    UNION_INSTANCE_ID: 'union-local',
    DATABASE_ENV: 'local',
    DATABASE_URL: FAKE_TEST_SECRET,
    PORT: '3000'
  });
  assert.equal(config.env, 'local');
  assert.equal(config.instanceId, 'union-local');
  assert.equal(config.databaseEnv, 'local');
  assert.equal(config.databaseUrl, FAKE_TEST_SECRET);
  assert.equal(config.port, 3000);
});

test('TEST 2: test/test environment pair = PASS', () => {
  const config = loadConfig({
    UNION_ENV: 'test',
    UNION_INSTANCE_ID: 'union-test-1',
    DATABASE_ENV: 'test',
    DATABASE_URL: FAKE_TEST_SECRET,
    PORT: '8080'
  });
  assert.equal(config.env, 'test');
  assert.equal(config.instanceId, 'union-test-1');
  assert.equal(config.databaseEnv, 'test');
});

test('TEST 3: production/production environment pair = PASS', () => {
  const config = loadConfig({
    UNION_ENV: 'production',
    UNION_INSTANCE_ID: 'union-prod-core-1',
    DATABASE_ENV: 'production',
    DATABASE_URL: FAKE_TEST_SECRET,
    PORT: '8000'
  });
  assert.equal(config.env, 'production');
  assert.equal(config.instanceId, 'union-prod-core-1');
  assert.equal(config.databaseEnv, 'production');
});

test('TEST 4: local/production mismatch = FAIL CLOSED', () => {
  assert.throws(
    () => {
      loadConfig({
        UNION_ENV: 'local',
        UNION_INSTANCE_ID: 'union-local',
        DATABASE_ENV: 'production',
        DATABASE_URL: FAKE_TEST_SECRET,
        PORT: '3000'
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof EnvironmentMismatchError);
      assert.ok((err as EnvironmentMismatchError).message.includes('Environment isolation mismatch'));
      return true;
    }
  );
});

test('TEST 5: production/local mismatch = FAIL CLOSED', () => {
  assert.throws(
    () => {
      loadConfig({
        UNION_ENV: 'production',
        UNION_INSTANCE_ID: 'union-prod-1',
        DATABASE_ENV: 'local',
        DATABASE_URL: FAKE_TEST_SECRET,
        PORT: '3000'
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof EnvironmentMismatchError);
      assert.ok((err as EnvironmentMismatchError).message.includes('Environment isolation mismatch'));
      return true;
    }
  );
});

test('TEST 6: test/production mismatch = FAIL CLOSED', () => {
  assert.throws(
    () => {
      loadConfig({
        UNION_ENV: 'test',
        UNION_INSTANCE_ID: 'union-test-1',
        DATABASE_ENV: 'production',
        DATABASE_URL: FAKE_TEST_SECRET,
        PORT: '3000'
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof EnvironmentMismatchError);
      return true;
    }
  );
});

test('TEST 7: Missing UNION_INSTANCE_ID = FAIL CLOSED', () => {
  assert.throws(
    () => {
      loadConfig({
        UNION_ENV: 'local',
        DATABASE_ENV: 'local',
        DATABASE_URL: FAKE_TEST_SECRET,
        PORT: '3000'
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof MissingConfigurationError);
      assert.ok((err as MissingConfigurationError).message.includes('UNION_INSTANCE_ID is required'));
      return true;
    }
  );
});

test('TEST 8: Empty UNION_INSTANCE_ID = FAIL CLOSED', () => {
  assert.throws(
    () => {
      loadConfig({
        UNION_ENV: 'local',
        UNION_INSTANCE_ID: '   ',
        DATABASE_ENV: 'local',
        DATABASE_URL: FAKE_TEST_SECRET,
        PORT: '3000'
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof MissingConfigurationError);
      assert.ok((err as MissingConfigurationError).message.includes('UNION_INSTANCE_ID is required'));
      return true;
    }
  );
});

test('TEST 9: Missing DATABASE_ENV = FAIL CLOSED', () => {
  assert.throws(
    () => {
      loadConfig({
        UNION_ENV: 'local',
        UNION_INSTANCE_ID: 'union-local',
        DATABASE_URL: FAKE_TEST_SECRET,
        PORT: '3000'
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof MissingConfigurationError);
      assert.ok((err as MissingConfigurationError).message.includes('DATABASE_ENV is required'));
      return true;
    }
  );
});

test('TEST 10: Invalid DATABASE_ENV = FAIL CLOSED', () => {
  assert.throws(
    () => {
      loadConfig({
        UNION_ENV: 'local',
        UNION_INSTANCE_ID: 'union-local',
        DATABASE_ENV: 'staging',
        DATABASE_URL: FAKE_TEST_SECRET,
        PORT: '3000'
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof InvalidConfigurationError);
      assert.ok((err as InvalidConfigurationError).message.includes('DATABASE_ENV must be one of'));
      return true;
    }
  );
});

test('TEST 11: No environment inference from NODE_ENV', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';

  try {
    const config = loadConfig({
      UNION_ENV: 'local',
      UNION_INSTANCE_ID: 'union-local',
      DATABASE_ENV: 'local',
      DATABASE_URL: FAKE_TEST_SECRET,
      PORT: '3000'
    });
    // NODE_ENV=production must NOT override explicit UNION_ENV=local
    assert.equal(config.env, 'local');
  } finally {
    if (originalNodeEnv !== undefined) {
      process.env.NODE_ENV = originalNodeEnv;
    } else {
      delete process.env.NODE_ENV;
    }
  }
});

test('TEST 12: No environment inference from DATABASE_URL', () => {
  const config = loadConfig({
    UNION_ENV: 'test',
    UNION_INSTANCE_ID: 'union-test-1',
    DATABASE_ENV: 'test',
    // Host contains 'prod' string, but config must strictly rely on explicit UNION_ENV & DATABASE_ENV
    DATABASE_URL: 'postgresql://union_app:secret@prod-db.internal:5432/union_prod',
    PORT: '3000'
  });
  assert.equal(config.env, 'test');
  assert.equal(config.databaseEnv, 'test');
});

test('TEST 13: Safe config summary contains no DATABASE_URL and includes instanceId & databaseEnvironment', () => {
  const config = loadConfig({
    UNION_ENV: 'local',
    UNION_INSTANCE_ID: 'union-local-1',
    DATABASE_ENV: 'local',
    DATABASE_URL: FAKE_TEST_SECRET,
    PORT: '3000'
  });

  const summary = getSafeConfigSummary(config);

  assert.equal(summary.environment, 'local');
  assert.equal(summary.instanceId, 'union-local-1');
  assert.equal(summary.databaseEnvironment, 'local');
  assert.equal(summary.databaseConfigured, true);
  assert.deepEqual(Object.keys(summary), ['environment', 'instanceId', 'databaseEnvironment', 'databaseConfigured']);

  assert.equal((summary as unknown as Record<string, unknown>).databaseUrl, undefined);
  const summaryStr = JSON.stringify(summary);
  assert.ok(!summaryStr.includes('databaseUrl'));
  assert.ok(!summaryStr.includes(FAKE_TEST_SECRET));
});

test('TEST 14: Mismatch prevents sensitive DB execution', async () => {
  await assert.rejects(
    async () => {
      await runMigrations({
        env: 'local',
        databaseEnv: 'production',
        password: 'fake-password'
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof EnvironmentMismatchError);
      return true;
    }
  );
});
