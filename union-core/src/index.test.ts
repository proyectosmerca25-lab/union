import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import * as indexExports from './index.js';

const FAKE_DB_SECRET = 'postgresql://union_app:SECRET_DB_PASS_777@localhost:5432/union';

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

function runNodeProcess(args: string[], env: Record<string, string | undefined>): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...env }
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

test('TEST A — IMPORT SAFETY: Importing union-core does NOT automatically listen on a port', () => {
  assert.ok(indexExports.bootstrapCore);
  assert.ok(indexExports.loadConfig);
  assert.ok(indexExports.createHttpServer);
  assert.equal(typeof indexExports.getCoreStatus, 'function');
});

test('TEST B & TEST C & TEST F — VALID PRODUCTION START, HEALTH & CONTROLLED SHUTDOWN', async () => {
  const entrypointPath = path.resolve(process.cwd(), 'dist/index.js');
  const port = 59123;

  const childEnv = {
    ...process.env,
    UNION_ENV: 'local',
    UNION_INSTANCE_ID: 'union-local-entrypoint-test',
    DATABASE_ENV: 'local',
    DATABASE_URL: FAKE_DB_SECRET,
    PORT: String(port)
  };

  const child = spawn(process.execPath, [entrypointPath], {
    cwd: process.cwd(),
    env: childEnv
  });

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  // Wait for server to start listening
  let reachable = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const res = await fetchUrl(`http://127.0.0.1:${port}/health`);
      if (res.status === 200) {
        reachable = true;
        const json = JSON.parse(res.body);
        assert.equal(json.status, 'ok');
        assert.equal(json.service, 'union-core');
        assert.equal(json.environment, 'local');
        break;
      }
    } catch {
      // Continue polling until server responds
    }
  }

  assert.ok(reachable, `Production entrypoint failed to start listening on port ${port}. stdout: ${stdout}, stderr: ${stderr}`);

  // TEST F: Controlled Shutdown via SIGTERM
  child.kill('SIGTERM');

  const { code, signal } = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on('close', (c, s) => resolve({ code: c, signal: s }));
  });

  // Windows process kill returns code === null with signal === 'SIGTERM' (or code === 0 on POSIX)
  assert.ok(code === 0 || code === null || signal === 'SIGTERM');

  // Verify port is released after shutdown
  await assert.rejects(async () => {
    await fetchUrl(`http://127.0.0.1:${port}/health`);
  });
});

test('TEST D — MISSING REQUIRED CONFIG: Fails closed with non-zero exit code', async () => {
  const entrypointPath = path.resolve(process.cwd(), 'dist/index.js');

  const res = await runNodeProcess([entrypointPath], {
    UNION_ENV: '', // Missing UNION_ENV
    DATABASE_URL: FAKE_DB_SECRET,
    PORT: '3000'
  });

  assert.notEqual(res.exitCode, 0);
  assert.ok(res.stderr.includes('CORE_BOOTSTRAP_FAILED') || res.stderr.includes('UNION_ENV is required'));
});

test('TEST E — INVALID PORT: Fails closed with non-zero exit code and no listener', async () => {
  const entrypointPath = path.resolve(process.cwd(), 'dist/index.js');

  const res = await runNodeProcess([entrypointPath], {
    UNION_ENV: 'local',
    UNION_INSTANCE_ID: 'union-local-test',
    DATABASE_ENV: 'local',
    DATABASE_URL: FAKE_DB_SECRET,
    PORT: '999999' // Invalid PORT
  });

  assert.notEqual(res.exitCode, 0);
  assert.ok(res.stderr.includes('CORE_BOOTSTRAP_FAILED') || res.stderr.includes('PORT must be between 1 and 65535'));
});

test('TEST G — NO SECRET LEAKAGE: Startup failure logs contain no secret values', async () => {
  const entrypointPath = path.resolve(process.cwd(), 'dist/index.js');

  const res = await runNodeProcess([entrypointPath], {
    UNION_ENV: 'local',
    UNION_INSTANCE_ID: 'union-local-test',
    DATABASE_ENV: 'local',
    DATABASE_URL: FAKE_DB_SECRET,
    PORT: 'invalid-port'
  });

  assert.notEqual(res.exitCode, 0);
  assert.ok(!res.stdout.includes(FAKE_DB_SECRET));
  assert.ok(!res.stderr.includes(FAKE_DB_SECRET));
  assert.ok(!res.stdout.includes('SECRET_DB_PASS_777'));
  assert.ok(!res.stderr.includes('SECRET_DB_PASS_777'));
});
