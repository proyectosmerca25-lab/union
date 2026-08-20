import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getWebStatus } from './index.js';

test('getWebStatus imports and resolves @union/shared correctly', () => {
  const status = getWebStatus();
  assert.equal(status.app, '@union/web');
  assert.equal(status.ready, true);
  assert.equal(status.systemVersion, '1.0.0-F1.2');
});
