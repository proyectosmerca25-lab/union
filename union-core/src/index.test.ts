import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bootstrapCore,
  CoreLifecycle,
  getCoreStatus,
  InvalidLifecycleTransitionError
} from './index.js';

test('TEST 1: Core lifecycle can be created in CREATED state', () => {
  const lifecycle = new CoreLifecycle();
  assert.equal(lifecycle.getState(), 'CREATED');
  assert.deepEqual(lifecycle.getHistory(), ['CREATED']);
});

test('TEST 2: Valid startup reaches RUNNING', async () => {
  const handle = await bootstrapCore();
  assert.equal(handle.lifecycle.getState(), 'RUNNING');
  assert.equal(handle.identity.service, '@union/core');
  assert.equal(handle.identity.baseline.status, 'FROZEN');
  await handle.stop();
});

test('TEST 3: Valid shutdown reaches STOPPED', async () => {
  const handle = await bootstrapCore();
  assert.equal(handle.lifecycle.getState(), 'RUNNING');

  await handle.stop();
  assert.equal(handle.lifecycle.getState(), 'STOPPED');
});

test('TEST 4: Lifecycle transition ordering is deterministic', async () => {
  const lifecycle = new CoreLifecycle();
  assert.equal(lifecycle.getState(), 'CREATED');

  await lifecycle.start();
  assert.equal(lifecycle.getState(), 'RUNNING');

  await lifecycle.stop();
  assert.equal(lifecycle.getState(), 'STOPPED');

  assert.deepEqual(lifecycle.getHistory(), ['CREATED', 'STARTING', 'RUNNING', 'STOPPING', 'STOPPED']);
});

test('TEST 5: At least one invalid lifecycle transition is rejected', async () => {
  const lifecycle = new CoreLifecycle();

  // Invalid transition: CREATED -> stop() (skipping STARTING/RUNNING)
  await assert.rejects(
    async () => {
      await lifecycle.stop();
    },
    (err: unknown) => {
      assert.ok(err instanceof InvalidLifecycleTransitionError);
      assert.equal((err as InvalidLifecycleTransitionError).currentState, 'CREATED');
      assert.equal((err as InvalidLifecycleTransitionError).targetState, 'STOPPING');
      return true;
    }
  );

  // Invalid transition: STARTING -> start() again
  await lifecycle.start();
  await assert.rejects(
    async () => {
      await lifecycle.start();
    },
    (err: unknown) => {
      assert.ok(err instanceof InvalidLifecycleTransitionError);
      assert.equal((err as InvalidLifecycleTransitionError).currentState, 'RUNNING');
      assert.equal((err as InvalidLifecycleTransitionError).targetState, 'STARTING');
      return true;
    }
  );

  await lifecycle.stop();
});

test('TEST 6: Repeated controlled shutdown does not corrupt runtime state', async () => {
  const handle = await bootstrapCore();
  assert.equal(handle.lifecycle.getState(), 'RUNNING');

  await handle.stop();
  assert.equal(handle.lifecycle.getState(), 'STOPPED');

  // Second stop call should be idempotent and remain STOPPED
  await handle.stop();
  assert.equal(handle.lifecycle.getState(), 'STOPPED');

  // Third stop call
  await handle.stop();
  assert.equal(handle.lifecycle.getState(), 'STOPPED');

  assert.deepEqual(handle.lifecycle.getHistory(), ['CREATED', 'STARTING', 'RUNNING', 'STOPPING', 'STOPPED']);
});

test('TEST 7: @union/core still resolves @union/shared correctly', () => {
  const status = getCoreStatus();
  assert.equal(status.service, '@union/core');
  assert.equal(status.initialized, true);
  assert.equal(status.baseline.status, 'FROZEN');
  assert.equal(status.baseline.name, 'UNIÓN System Architecture');
  assert.equal(status.baseline.version, '1.0.0-F1.2');
});
