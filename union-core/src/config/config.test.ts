import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getSafeConfigSummary,
  InvalidConfigurationError,
  loadConfig,
  MissingConfigurationError
} from './config.js';

const FAKE_TEST_SECRET = 'postgresql://union_app:FAKE_TEST_SECRET_KEY_12345@localhost:5432/union';

test('TEST 1: Valid local configuration = PASS', () => {
  const config = loadConfig({
    UNION_ENV: 'local',
    DATABASE_URL: FAKE_TEST_SECRET,
    PORT: '3000'
  });
  assert.equal(config.env, 'local');
  assert.equal(config.databaseUrl, FAKE_TEST_SECRET);
  assert.equal(config.port, 3000);
});

test('TEST 2: Valid test configuration = PASS', () => {
  const config = loadConfig({
    UNION_ENV: 'test',
    DATABASE_URL: FAKE_TEST_SECRET,
    PORT: '8080'
  });
  assert.equal(config.env, 'test');
  assert.equal(config.databaseUrl, FAKE_TEST_SECRET);
  assert.equal(config.port, 8080);
});

test('TEST 3: Valid production configuration = PASS', () => {
  const config = loadConfig({
    UNION_ENV: 'production',
    DATABASE_URL: FAKE_TEST_SECRET,
    PORT: '8000'
  });
  assert.equal(config.env, 'production');
  assert.equal(config.databaseUrl, FAKE_TEST_SECRET);
  assert.equal(config.port, 8000);
});

test('TEST 4: Missing UNION_ENV = FAIL CLOSED', () => {
  assert.throws(
    () => {
      loadConfig({ DATABASE_URL: FAKE_TEST_SECRET, PORT: '3000' });
    },
    (err: unknown) => {
      assert.ok(err instanceof MissingConfigurationError);
      assert.ok((err as MissingConfigurationError).message.includes('UNION_ENV is required'));
      return true;
    }
  );
});

test('TEST 5: Invalid UNION_ENV = FAIL CLOSED', () => {
  const invalidEnvs = ['dev', 'development', 'prod', 'staging', 'qa'];
  for (const envVal of invalidEnvs) {
    assert.throws(
      () => {
        loadConfig({ UNION_ENV: envVal, DATABASE_URL: FAKE_TEST_SECRET, PORT: '3000' });
      },
      (err: unknown) => {
        assert.ok(err instanceof InvalidConfigurationError);
        assert.ok((err as InvalidConfigurationError).message.includes('UNION_ENV must be one of'));
        return true;
      }
    );
  }
});

test('TEST 6: Missing required DATABASE_URL = FAIL CLOSED', () => {
  assert.throws(
    () => {
      loadConfig({ UNION_ENV: 'local', PORT: '3000' });
    },
    (err: unknown) => {
      assert.ok(err instanceof MissingConfigurationError);
      assert.ok((err as MissingConfigurationError).message.includes('DATABASE_URL is required'));
      assert.ok(!(err as MissingConfigurationError).message.includes('postgresql://'));
      return true;
    }
  );
});

test('TEST 7 & TEST 8 & TEST 13: Safe config summary does not expose DATABASE_URL or fake secret', () => {
  const config = loadConfig({
    UNION_ENV: 'local',
    DATABASE_URL: FAKE_TEST_SECRET,
    PORT: '3000'
  });

  const summary = getSafeConfigSummary(config);

  assert.equal(summary.environment, 'local');
  assert.equal(summary.databaseConfigured, true);
  assert.deepEqual(Object.keys(summary), ['environment', 'databaseConfigured']);

  assert.equal((summary as unknown as Record<string, unknown>).databaseUrl, undefined);
  const summaryStr = JSON.stringify(summary);
  assert.ok(!summaryStr.includes('databaseUrl'));
  assert.ok(!summaryStr.includes(FAKE_TEST_SECRET));
  assert.ok(!summaryStr.includes('FAKE_TEST_SECRET_KEY_12345'));
});

test('TEST 9: Configuration cannot be mutated after creation', () => {
  const config = loadConfig({
    UNION_ENV: 'local',
    DATABASE_URL: FAKE_TEST_SECRET,
    PORT: '3000'
  });

  assert.ok(Object.isFrozen(config));

  assert.throws(() => {
    (config as unknown as Record<string, unknown>).env = 'production';
  }, TypeError);

  assert.throws(() => {
    (config as unknown as Record<string, unknown>).databaseUrl = 'tampered';
  }, TypeError);

  assert.throws(() => {
    (config as unknown as Record<string, unknown>).port = 9999;
  }, TypeError);

  assert.equal(config.env, 'local');
  assert.equal(config.databaseUrl, FAKE_TEST_SECRET);
  assert.equal(config.port, 3000);
});

test('TEST 10: No sensitive operational default exists', () => {
  assert.throws(
    () => {
      loadConfig({});
    },
    (err: unknown) => {
      assert.ok(err instanceof MissingConfigurationError);
      return true;
    }
  );
});

test('TEST 11: No future provider secret/config placeholders introduced', () => {
  const config = loadConfig({
    UNION_ENV: 'local',
    DATABASE_URL: FAKE_TEST_SECRET,
    PORT: '3000'
  });

  const configKeys = Object.keys(config);
  assert.deepEqual(configKeys, ['env', 'databaseUrl', 'port']);

  const untrackedKeys = ['OPENAI_API_KEY', 'TENCENT_SECRET', 'GRAPHIFY_KEY', 'GITHUB_TOKEN', 'RAILWAY_KEY'];
  for (const key of untrackedKeys) {
    assert.equal((config as unknown as Record<string, unknown>)[key], undefined);
  }
});

test('PORT VALIDATION: Missing PORT = FAIL CLOSED', () => {
  assert.throws(
    () => {
      loadConfig({ UNION_ENV: 'local', DATABASE_URL: FAKE_TEST_SECRET });
    },
    (err: unknown) => {
      assert.ok(err instanceof MissingConfigurationError);
      assert.ok((err as MissingConfigurationError).message.includes('PORT is required'));
      return true;
    }
  );
});

test('PORT VALIDATION: Non-numeric PORT = FAIL CLOSED', () => {
  assert.throws(
    () => {
      loadConfig({ UNION_ENV: 'local', DATABASE_URL: FAKE_TEST_SECRET, PORT: 'abc' });
    },
    (err: unknown) => {
      assert.ok(err instanceof InvalidConfigurationError);
      assert.ok((err as InvalidConfigurationError).message.includes('PORT must be a valid integer'));
      return true;
    }
  );
});

test('PORT VALIDATION: PORT < 1 = FAIL CLOSED', () => {
  assert.throws(
    () => {
      loadConfig({ UNION_ENV: 'local', DATABASE_URL: FAKE_TEST_SECRET, PORT: '0' });
    },
    (err: unknown) => {
      assert.ok(err instanceof InvalidConfigurationError);
      assert.ok((err as InvalidConfigurationError).message.includes('PORT must be between 1 and 65535'));
      return true;
    }
  );
});

test('PORT VALIDATION: PORT > 65535 = FAIL CLOSED', () => {
  assert.throws(
    () => {
      loadConfig({ UNION_ENV: 'local', DATABASE_URL: FAKE_TEST_SECRET, PORT: '65536' });
    },
    (err: unknown) => {
      assert.ok(err instanceof InvalidConfigurationError);
      assert.ok((err as InvalidConfigurationError).message.includes('PORT must be between 1 and 65535'));
      return true;
    }
  );
});
