import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCoreStatus } from './index.js';

test('getCoreStatus imports and resolves @union/shared correctly', () => {
  const status = getCoreStatus();
  assert.equal(status.service, '@union/core');
  assert.equal(status.initialized, true);
  assert.equal(status.baseline.status, 'FROZEN');
  assert.equal(status.baseline.name, 'UNIÓN System Architecture');
});
