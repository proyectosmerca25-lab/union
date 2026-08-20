import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToString } from 'react-dom/server';
import { App, getWebStatus } from './index.js';
import { UNION_SYSTEM_VERSION } from '@union/shared';

test('TEST 1 & TEST 5: React App renders successfully via renderToString', () => {
  const html = renderToString(<App />);
  assert.ok(typeof html === 'string');
  assert.ok(html.length > 0);
});

test('TEST 2: UNIÓN identity is visible in rendered UI', () => {
  const html = renderToString(<App />);
  assert.ok(html.includes('UNIÓN'));
});

test('TEST 3: Web Foundation status is READY', () => {
  const html = renderToString(<App />);
  assert.ok(html.includes('Web Foundation'));
  assert.ok(html.includes('Status: READY'));

  const status = getWebStatus();
  assert.equal(status.app, '@union/web');
  assert.equal(status.ready, true);
});

test('TEST 4: @union/shared integration resolves correctly in rendered output', () => {
  const html = renderToString(<App />);
  assert.ok(html.includes(UNION_SYSTEM_VERSION));
  assert.ok(html.includes('System Architecture'));
});
