import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { bootstrapCore } from '../app/bootstrap.js';
import { EnvironmentMismatchError, loadConfig } from '../config/config.js';
import { MissingDatabaseConfigurationError, runMigrations } from '../db/migrations/runner.js';
import { createHttpServer } from '../http/server.js';
import { createLogger } from '../logging/logger.js';

function fetchUrl(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: data });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('TEST 15 & TEST 16 & TEST 17 & TEST 18: Local Foundation E2E Validation', async () => {
  const password = process.env.POSTGRES_PASSWORD;
  if (!password || password.trim() === '') {
    throw new MissingDatabaseConfigurationError(
      'Missing required database configuration: POSTGRES_PASSWORD is required and cannot be empty'
    );
  }
  const databaseUrl = `postgresql://union_app:${password}@localhost:5432/union`;

  // 1. Validate configuration
  const config = loadConfig({
    UNION_ENV: 'local',
    UNION_INSTANCE_ID: 'union-local-e2e',
    DATABASE_ENV: 'local',
    DATABASE_URL: databaseUrl,
    PORT: '3000'
  });

  assert.equal(config.env, 'local');
  assert.equal(config.databaseEnv, 'local');
  assert.equal(config.instanceId, 'union-local-e2e');

  // 2. Logger setup
  const logger = createLogger('e2e-runner', { env: config.env });
  logger.info('E2E_STARTED', { message: 'Starting Foundation E2E test...' });

  // 3. Migration execution against PostgreSQL 18.4
  const migrationsDir = path.resolve(process.cwd(), 'migrations');
  const fallbackMigrationsDir = path.resolve(process.cwd(), 'union-core/migrations');
  const targetDir = (await import('fs')).existsSync(migrationsDir)
    ? migrationsDir
    : fallbackMigrationsDir;

  const migResult = await runMigrations({
    env: config.env,
    databaseEnv: config.databaseEnv,
    password,
    migrationsDir: targetDir
  });

  assert.ok(migResult.appliedCount >= 0);
  assert.ok(migResult.alreadyAppliedCount >= 1 || migResult.appliedCount >= 1);

  // 4. Core Lifecycle Bootstrap
  const coreHandle = await bootstrapCore();
  assert.equal(coreHandle.lifecycle.getState(), 'RUNNING');

  // 5. Native HTTP Server Startup
  const httpHandle = createHttpServer({
    port: 0, // Ephemeral port for isolated E2E execution
    host: '127.0.0.1',
    env: config.env,
    serviceVersion: coreHandle.identity.version,
    logger
  });

  const boundPort = await httpHandle.listen();
  assert.ok(boundPort > 0);

  try {
    // 6. Issue GET /health request
    const res = await fetchUrl(`http://127.0.0.1:${boundPort}/health`);
    assert.equal(res.status, 200);

    const json = JSON.parse(res.body);
    assert.equal(json.status, 'ok');
    assert.equal(json.service, 'union-core');
    assert.equal(json.environment, 'local');
  } finally {
    // 7. Controlled Shutdown
    await httpHandle.close();
    await coreHandle.stop();
  }

  // 8. Verify port release after shutdown
  await assert.rejects(async () => {
    await fetchUrl(`http://127.0.0.1:${boundPort}/health`);
  });

  logger.info('E2E_COMPLETED', { message: 'Foundation E2E test completed successfully' });
});

test('E2E MISMATCH PATH: Mismatch fails closed before DB execution', async () => {
  const password = process.env.POSTGRES_PASSWORD ?? 'dummy_value_for_mismatch_test';
  const databaseUrl = `postgresql://union_app:${password}@localhost:5432/union`;

  // Config validation fails before DB execution
  assert.throws(
    () => {
      loadConfig({
        UNION_ENV: 'local',
        UNION_INSTANCE_ID: 'union-local-e2e',
        DATABASE_ENV: 'production',
        DATABASE_URL: databaseUrl,
        PORT: '3000'
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof EnvironmentMismatchError);
      return true;
    }
  );
});
