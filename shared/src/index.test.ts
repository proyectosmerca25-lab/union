import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSystemBaseline, UNION_SYSTEM_VERSION } from './index.js';

test('getSystemBaseline returns valid FROZEN baseline metadata', () => {
  const baseline = getSystemBaseline();
  assert.equal(baseline.name, 'UNIÓN System Architecture');
  assert.equal(baseline.version, UNION_SYSTEM_VERSION);
  assert.equal(baseline.status, 'FROZEN');
});
