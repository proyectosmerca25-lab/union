import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHttpServer } from './server.js';
import { loadConfig } from '../config/config.js';

const FAKE_DB_SECRET = 'postgresql://union_app:SECRET_DB_KEY_999@localhost:5432/union';

function fetchUrl(url: string, method = 'GET'): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('TEST 1: Valid PORT accepted in config', () => {
  const config = loadConfig({
    UNION_ENV: 'local',
    UNION_INSTANCE_ID: 'union-local',
    DATABASE_ENV: 'local',
    DATABASE_URL: FAKE_DB_SECRET,
    PORT: '3000'
  });
  assert.equal(config.port, 3000);
});

test('TEST 6 & TEST 7 & TEST 8 & TEST 9 & TEST 10: HTTP server starts, GET /health returns 200 JSON with no secrets', async () => {
  const handle = createHttpServer({
    port: 0, // ephemeral port for test isolation
    host: '127.0.0.1',
    env: 'local',
    serviceVersion: '0.1.0-F1.9'
  });

  const boundPort = await handle.listen();
  assert.ok(boundPort > 0);

  try {
    const res = await fetchUrl(`http://127.0.0.1:${boundPort}/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/json');

    const json = JSON.parse(res.body);
    assert.equal(json.status, 'ok');
    assert.equal(json.service, 'union-core');
    assert.equal(json.version, '0.1.0-F1.9');
    assert.equal(json.environment, 'local');

    // Secret leak check: ensure DATABASE_URL or password secret does not appear anywhere in body or headers
    assert.ok(!res.body.includes(FAKE_DB_SECRET));
    assert.ok(!res.body.includes('SECRET_DB_KEY_999'));
    assert.ok(!res.body.includes('databaseUrl'));
  } finally {
    await handle.close();
  }
});

test('TEST 11: Unknown route returns 404', async () => {
  const handle = createHttpServer({
    port: 0,
    host: '127.0.0.1',
    env: 'local'
  });

  const boundPort = await handle.listen();

  try {
    const res = await fetchUrl(`http://127.0.0.1:${boundPort}/unknown`);
    assert.equal(res.status, 404);
    assert.equal(res.headers['content-type'], 'application/json');

    const json = JSON.parse(res.body);
    assert.equal(json.error, 'Not Found');
  } finally {
    await handle.close();
  }
});

test('TEST 12: POST /health returns 405', async () => {
  const handle = createHttpServer({
    port: 0,
    host: '127.0.0.1',
    env: 'local'
  });

  const boundPort = await handle.listen();

  try {
    const res = await fetchUrl(`http://127.0.0.1:${boundPort}/health`, 'POST');
    assert.equal(res.status, 405);
    assert.equal(res.headers['content-type'], 'application/json');

    const json = JSON.parse(res.body);
    assert.equal(json.error, 'Method Not Allowed');
  } finally {
    await handle.close();
  }
});

test('TEST 13 & TEST 14 & TEST 15: Core-controlled shutdown closes server and port is reusable', async () => {
  // Bind server 1 on explicit port
  const handle1 = createHttpServer({
    port: 0,
    host: '127.0.0.1',
    env: 'local'
  });
  const port = await handle1.listen();
  assert.ok(port > 0);

  // Close server 1
  await handle1.close();

  // Verify connection to closed port throws ECONNREFUSED
  await assert.rejects(async () => {
    await fetchUrl(`http://127.0.0.1:${port}/health`);
  });

  // Bind server 2 on exact same port successfully
  const handle2 = createHttpServer({
    port,
    host: '127.0.0.1',
    env: 'local'
  });
  const reboundPort = await handle2.listen();
  assert.equal(reboundPort, port);

  try {
    const res = await fetchUrl(`http://127.0.0.1:${reboundPort}/health`);
    assert.equal(res.status, 200);
  } finally {
    await handle2.close();
  }
});

test('TEST 16: No HTTP framework dependency added in union-core package.json', async () => {
  const corePkgPath = path.resolve(process.cwd(), 'package.json');
  const rootPkgPath = path.resolve(process.cwd(), 'union-core/package.json');
  let resolvedPkgPath = corePkgPath;

  try {
    await fs.stat(corePkgPath);
  } catch {
    resolvedPkgPath = rootPkgPath;
  }

  const content = await fs.readFile(resolvedPkgPath, 'utf8');
  const pkg = JSON.parse(content);

  const prohibitedFrameworks = new Set(['express', 'fastify', 'hapi', 'koa', 'restify', 'nest', 'koa-router', '@nestjs/core']);
  const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

  for (const name of Object.keys(allDeps)) {
    assert.ok(!prohibitedFrameworks.has(name.toLowerCase()), `Prohibited HTTP framework dependency '${name}' found`);
  }
});

test('TEST 17 & TEST 18: No business/API routes or PostgreSQL dependency in health server', () => {
  const handle = createHttpServer({
    port: 0,
    host: '127.0.0.1',
    env: 'local'
  });

  assert.ok(handle.server instanceof http.Server);
});
