import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger, FormattedLogEvent, LogLevel } from './logger.js';

const FAKE_DATABASE_URL = 'postgresql://union_app:FAKE_SECRET_PASSWORD_99@localhost:5432/union';
const FAKE_PASSWORD_SECRET = 'SuperSecretLocalPassword123!';
const FAKE_TOKEN_SECRET = 'bearer_token_abc123xyz_fake';

function createCapturedLogger(env: 'local' | 'test' | 'production' = 'test') {
  const captured: { level: LogLevel; jsonLine: string; event: FormattedLogEvent }[] = [];
  const logger = createLogger('test-component', {
    env,
    secretsToRedact: [FAKE_DATABASE_URL, FAKE_PASSWORD_SECRET, FAKE_TOKEN_SECRET],
    outputHandler: (level, jsonLine, event) => {
      captured.push({ level, jsonLine, event });
    }
  });
  return { logger, captured };
}

test('TEST 1: INFO emits valid structured JSON', () => {
  const { logger, captured } = createCapturedLogger();
  logger.info('CORE_STARTED', { message: 'Core runtime booted successfully' });

  assert.equal(captured.length, 1);
  assert.equal(captured[0].level, 'info');

  const parsed = JSON.parse(captured[0].jsonLine);
  assert.equal(parsed.event, 'CORE_STARTED');
  assert.equal(parsed.component, 'test-component');
  assert.equal(parsed.message, 'Core runtime booted successfully');
});

test('TEST 2: WARN emits valid structured JSON', () => {
  const { logger, captured } = createCapturedLogger();
  logger.warn('CONFIG_DEPRECATION_WARNING', { message: 'Legacy flag detected' });

  assert.equal(captured.length, 1);
  assert.equal(captured[0].level, 'warn');

  const parsed = JSON.parse(captured[0].jsonLine);
  assert.equal(parsed.event, 'CONFIG_DEPRECATION_WARNING');
  assert.equal(parsed.level, 'warn');
});

test('TEST 3: ERROR emits valid structured JSON', () => {
  const { logger, captured } = createCapturedLogger();
  logger.error('DATABASE_CONNECTION_FAILED', {
    message: 'Could not connect to database',
    error: new Error('Connection refused')
  });

  assert.equal(captured.length, 1);
  assert.equal(captured[0].level, 'error');

  const parsed = JSON.parse(captured[0].jsonLine);
  assert.equal(parsed.event, 'DATABASE_CONNECTION_FAILED');
  assert.equal(parsed.error.name, 'Error');
  assert.equal(parsed.error.message, 'Connection refused');
});

test('TEST 4: Required fields exist in log envelope', () => {
  const { logger, captured } = createCapturedLogger();
  logger.info('TEST_EVENT');

  const event = captured[0].event;
  assert.ok(event.timestamp, 'timestamp must be defined');
  assert.ok(event.level, 'level must be defined');
  assert.ok(event.event, 'event must be defined');
  assert.ok(event.component, 'component must be defined');

  assert.equal(event.level, 'info');
  assert.equal(event.event, 'TEST_EVENT');
  assert.equal(event.component, 'test-component');
});

test('TEST 5: timestamp is valid ISO-8601', () => {
  const { logger, captured } = createCapturedLogger();
  logger.info('ISO_CHECK');

  const iso = captured[0].event.timestamp;
  const parsedDate = new Date(iso);
  assert.ok(!isNaN(parsedDate.getTime()), 'Date parsing should succeed');
  assert.equal(iso, parsedDate.toISOString(), 'Timestamp format must match ISO-8601 UTC string');
});

test('TEST 6: Optional traceId is preserved as opaque safe metadata', () => {
  const { logger, captured } = createCapturedLogger();
  const traceId = 'trace_req_123456789_xyz';
  logger.info('TRACED_OPERATION', { traceId });

  assert.equal(captured[0].event.traceId, traceId);
  const parsed = JSON.parse(captured[0].jsonLine);
  assert.equal(parsed.traceId, traceId);
});

test('TEST 7: Safe context accepts approved primitive metadata', () => {
  const { logger, captured } = createCapturedLogger();
  logger.info('PRIMITIVE_CONTEXT', {
    context: {
      attemptCount: 3,
      isPrimary: true,
      serviceName: 'core-service'
    }
  });

  const ctx = captured[0].event.context;
  assert.ok(ctx);
  assert.equal(ctx.attemptCount, 3);
  assert.equal(ctx.isPrimary, true);
  assert.equal(ctx.serviceName, 'core-service');
});

test('TEST 8: Unsupported/arbitrary context is not blindly serialized', () => {
  const { logger, captured } = createCapturedLogger();

  const unsafeObject = { secretData: 'hidden', nested: { foo: 'bar' } };
  const unsafeArray = [1, 2, 3];

  logger.info('ARBITRARY_CONTEXT_ATTEMPT', {
    context: {
      allowedKey: 'safe-value',
      // Cast as unknown to test rejection of invalid types
      forbiddenObject: unsafeObject as unknown as string,
      forbiddenArray: unsafeArray as unknown as string,
      forbiddenFunc: (() => 'nope') as unknown as string
    }
  });

  const ctx = captured[0].event.context;
  assert.ok(ctx);
  assert.equal(ctx.allowedKey, 'safe-value');

  // Verify non-primitive keys were rejected and omitted from context
  assert.equal((ctx as unknown as Record<string, unknown>).forbiddenObject, undefined);
  assert.equal((ctx as unknown as Record<string, unknown>).forbiddenArray, undefined);
  assert.equal((ctx as unknown as Record<string, unknown>).forbiddenFunc, undefined);

  const jsonStr = captured[0].jsonLine;
  assert.ok(!jsonStr.includes('forbiddenObject'));
  assert.ok(!jsonStr.includes('forbiddenArray'));
});

test('TEST 9: DATABASE_URL value cannot appear in emitted output', () => {
  const { logger, captured } = createCapturedLogger();
  logger.error('DB_ERROR', {
    message: `Failed connecting to ${FAKE_DATABASE_URL}`,
    error: new Error(`Database connection at ${FAKE_DATABASE_URL} failed`),
    context: { url: FAKE_DATABASE_URL }
  });

  const jsonLine = captured[0].jsonLine;
  assert.ok(!jsonLine.includes(FAKE_DATABASE_URL), 'Full DATABASE_URL must not appear in log');
  assert.ok(!jsonLine.includes('FAKE_SECRET_PASSWORD_99'), 'Embedded password must not appear in log');
  assert.ok(jsonLine.includes('[REDACTED_SECRET]'), 'Secret should be replaced with redaction placeholder');
});

test('TEST 10: Password-like sensitive value used in test cannot appear in output', () => {
  const { logger, captured } = createCapturedLogger();
  logger.error('AUTH_FAIL', {
    message: `Attempted password: ${FAKE_PASSWORD_SECRET}`,
    context: { password: `password = ${FAKE_PASSWORD_SECRET}` }
  });

  const jsonLine = captured[0].jsonLine;
  assert.ok(!jsonLine.includes(FAKE_PASSWORD_SECRET), 'Password secret must not appear in log');
  assert.ok(jsonLine.includes('[REDACTED_SECRET]'));
});

test('TEST 11: Token-like sensitive value used in test cannot appear in output', () => {
  const { logger, captured } = createCapturedLogger();
  logger.info('TOKEN_EVENT', {
    message: `Received header Authorization: Bearer ${FAKE_TOKEN_SECRET}`,
    context: { token: FAKE_TOKEN_SECRET }
  });

  const jsonLine = captured[0].jsonLine;
  assert.ok(!jsonLine.includes(FAKE_TOKEN_SECRET), 'Token secret must not appear in log');
  assert.ok(jsonLine.includes('[REDACTED_SECRET]'));
});

test('TEST 12: Production error serialization does NOT expose stack', () => {
  const { logger, captured } = createCapturedLogger('production');
  const err = new Error('Production error message');
  logger.error('PROD_ERROR', { error: err });

  const logError = captured[0].event.error;
  assert.ok(logError);
  assert.equal(logError.name, 'Error');
  assert.equal(logError.message, 'Production error message');
  assert.equal(logError.stack, undefined, 'Stack trace must be undefined in production mode');

  const jsonLine = captured[0].jsonLine;
  assert.ok(!jsonLine.includes('"stack":'), 'JSON output must not contain stack field in production');
});

test('TEST 13: Safe error serialization preserves approved error identity', () => {
  const { logger, captured } = createCapturedLogger('test');
  class CustomAppError extends Error {
    readonly code = 'ERR_CUSTOM_APP_FAILURE';
    constructor(msg: string) {
      super(msg);
      this.name = 'CustomAppError';
    }
  }

  const customErr = new CustomAppError('Failure in module X');
  logger.error('CUSTOM_ERROR', { error: customErr });

  const logError = captured[0].event.error;
  assert.ok(logError);
  assert.equal(logError.name, 'CustomAppError');
  assert.equal(logError.message, 'Failure in module X');
  assert.equal(logError.code, 'ERR_CUSTOM_APP_FAILURE');
  assert.ok(logError.stack !== undefined, 'Stack is allowed in non-production environments');
});

test('TEST 14: No new direct console usage exists outside logger boundary in union-core src', async () => {
  const srcDir = path.resolve(process.cwd(), 'union-core/src');
  const fallbackSrcDir = fs.stat(srcDir).then(() => srcDir).catch(() => path.resolve(process.cwd(), 'src'));

  const resolvedSrcDir = await fallbackSrcDir;

  async function searchConsoleUsage(dir: string): Promise<string[]> {
    const violations: string[] = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        violations.push(...(await searchConsoleUsage(fullPath)));
      } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
        // Exclude logger implementation itself and tests/main standalone runner
        if (
          entry.name === 'logger.ts' ||
          entry.name.endsWith('.test.ts') ||
          entry.name === 'index.ts' ||
          entry.name === 'cli.ts'
        ) {
          continue;
        }

        const content = await fs.readFile(fullPath, 'utf8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (/console\.(log|info|warn|error|dir|debug)\s*\(/.test(line)) {
            violations.push(`${fullPath}:${i + 1}: ${line.trim()}`);
          }
        }
      }
    }
    return violations;
  }

  const violations = await searchConsoleUsage(resolvedSrcDir);
  assert.deepEqual(violations, [], `Direct console usage found outside logger boundary: ${violations.join('\n')}`);
});

test('TEST 15: No new runtime/dev logging dependency exists in union-core package.json', async () => {
  const pkgPath = path.resolve(process.cwd(), 'union-core/package.json');
  const fallbackPkgPath = fs.stat(pkgPath).then(() => pkgPath).catch(() => path.resolve(process.cwd(), 'package.json'));

  const resolvedPkgPath = await fallbackPkgPath;
  const content = await fs.readFile(resolvedPkgPath, 'utf8');
  const pkg = JSON.parse(content);

  const prohibited = ['pino', 'winston', 'bunyan', 'log4js', 'sentry', 'datadog', '@opentelemetry/api'];

  const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  for (const name of Object.keys(allDeps)) {
    for (const p of prohibited) {
      assert.ok(!name.toLowerCase().includes(p), `Prohibited logging dependency '${name}' found in package.json`);
    }
  }
});
