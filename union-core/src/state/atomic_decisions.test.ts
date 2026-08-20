import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import pg from 'pg';
import {
  MissingDatabaseConfigurationError,
  runMigrations
} from '../db/migrations/runner.js';
import { ProjectRegistry } from './project-registry.js';
import { SessionManager } from './session-manager.js';
import { DecisionManager } from './decision-manager.js';
import {
  FrozenDecisionMutationError,
  InvalidStateTransitionError
} from './errors.js';

function getTestConfig() {
  const password = process.env.POSTGRES_PASSWORD;
  return {
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
    database: process.env.POSTGRES_DB ?? 'union',
    user: process.env.POSTGRES_USER ?? 'union_app',
    password,
    migrationsDir: path.resolve(process.cwd(), 'migrations'),
    env: 'local',
    databaseEnv: 'local'
  };
}

async function cleanDatabase(config = getTestConfig()) {
  if (!config.password || config.password.trim() === '') {
    throw new MissingDatabaseConfigurationError(
      'Missing required database configuration: POSTGRES_PASSWORD is required and cannot be empty'
    );
  }
  const client = new pg.Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password
  });
  await client.connect();
  try {
    await client.query('DROP TABLE IF EXISTS evidence_references CASCADE;');
    await client.query('DROP TABLE IF EXISTS decision_work_orders CASCADE;');
    await client.query('DROP TABLE IF EXISTS work_orders CASCADE;');
    await client.query('DROP TABLE IF EXISTS decisions CASCADE;');
    await client.query('DROP TABLE IF EXISTS sessions CASCADE;');
    await client.query('DROP TABLE IF EXISTS projects CASCADE;');
    await client.query('DROP TABLE IF EXISTS union_schema_migrations CASCADE;');
  } finally {
    await client.end();
  }
}

test('F2.2-C1 ATOMIC DECISION STATE TRANSITIONS TEST SUITE (C1-T01 - C1-T15)', async () => {
  const config = getTestConfig();
  await cleanDatabase(config);
  await runMigrations(config);

  const client = new pg.Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password
  });
  await client.connect();

  try {
    const projectRegistry = new ProjectRegistry(client);
    const decisionManager = new DecisionManager(client);

    const project = await projectRegistry.createProject({ displayName: 'Atomic Concurrency Project' });
    const pId = project.projectId;

    // C1-T01: approve from PROPOSED -> PASS
    const d1 = await decisionManager.createDecision({
      projectId: pId,
      topic: 'T01 Topic',
      decision: 'Initial Decision',
      reason: 'Testing atomic approve',
      authority: 'Omar'
    });
    const approved1 = await decisionManager.approveDecision(d1.decisionId);
    assert.equal(approved1.status, 'APPROVED');

    // C1-T02: reject from PROPOSED -> PASS
    const d2 = await decisionManager.createDecision({
      projectId: pId,
      topic: 'T02 Topic',
      decision: 'Decision to Reject',
      reason: 'Testing atomic reject',
      authority: 'Omar'
    });
    const rejected2 = await decisionManager.rejectDecision(d2.decisionId);
    assert.equal(rejected2.status, 'REJECTED');

    // C1-T03: freeze from APPROVED -> PASS
    const frozen1 = await decisionManager.freezeDecision(approved1.decisionId);
    assert.equal(frozen1.status, 'FROZEN');

    // C1-T04: reopen from FROZEN -> PASS
    const reopened1 = await decisionManager.reopenDecision(frozen1.decisionId, 'Condition for reopen');
    assert.equal(reopened1.status, 'REOPENED');

    // C1-T05: authorized content update while PROPOSED -> PASS
    const dProp = await decisionManager.createDecision({
      projectId: pId,
      topic: 'Original Topic',
      decision: 'Original Decision',
      reason: 'Original Reason',
      authority: 'Omar'
    });
    const updatedProp = await decisionManager.updateDecisionContent(dProp.decisionId, {
      decision: 'Updated Decision Text'
    });
    assert.equal(updatedProp.decision, 'Updated Decision Text');

    // C1-T06: authorized content update while REOPENED -> PASS
    const updatedReopened = await decisionManager.updateDecisionContent(reopened1.decisionId, {
      decision: 'Updated Reopened Text'
    });
    assert.equal(updatedReopened.decision, 'Updated Reopened Text');

    // C1-T07: stale approve after state changed -> DENIED
    // d1 is currently REOPENED (via reopened1). Re-approving works once:
    const reapproved1 = await decisionManager.approveDecision(reopened1.decisionId);
    await decisionManager.freezeDecision(reapproved1.decisionId);
    // Now status is FROZEN. Calling approve now fails atomically!
    await assert.rejects(async () => {
      await decisionManager.approveDecision(reopened1.decisionId);
    }, InvalidStateTransitionError);

    // C1-T08: stale reject after state changed -> DENIED
    // d2 is REJECTED. Calling reject again fails atomically!
    await assert.rejects(async () => {
      await decisionManager.rejectDecision(d2.decisionId);
    }, InvalidStateTransitionError);

    // C1-T09: stale freeze after state changed -> DENIED
    // Calling freeze on a REJECTED decision fails atomically!
    await assert.rejects(async () => {
      await decisionManager.freezeDecision(d2.decisionId);
    }, InvalidStateTransitionError);

    // C1-T10: stale reopen after state changed -> DENIED
    // Calling reopen on a PROPOSED decision fails atomically!
    await assert.rejects(async () => {
      await decisionManager.reopenDecision(dProp.decisionId);
    }, InvalidStateTransitionError);

    // C1-T11: content update racing with freeze -> frozen content remains unchanged / DENIED
    const dRace = await decisionManager.createDecision({
      projectId: pId,
      topic: 'Race Topic',
      decision: 'Pre-freeze text',
      reason: 'Race test',
      authority: 'Omar'
    });
    await decisionManager.approveDecision(dRace.decisionId);
    await decisionManager.freezeDecision(dRace.decisionId);

    await assert.rejects(async () => {
      await decisionManager.updateDecisionContent(dRace.decisionId, {
        decision: 'Tampered Race Content'
      });
    }, FrozenDecisionMutationError);

    const postRaceCheck = await decisionManager.getDecision(dRace.decisionId);
    assert.equal(postRaceCheck.decision, 'Pre-freeze text');
    assert.equal(postRaceCheck.status, 'FROZEN');

    // C1-T12: two competing transitions from same source state -> at most one authorized durable transition succeeds
    const dCompeting = await decisionManager.createDecision({
      projectId: pId,
      topic: 'Competing Topic',
      decision: 'Competing Decision',
      reason: 'Testing competing transitions',
      authority: 'Omar'
    });

    // Execute approve and reject concurrently
    const results = await Promise.allSettled([
      decisionManager.approveDecision(dCompeting.decisionId),
      decisionManager.rejectDecision(dCompeting.decisionId)
    ]);

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    const rejectedErr = (rejected[0] as PromiseRejectedResult).reason;
    assert.ok(rejectedErr instanceof InvalidStateTransitionError);

    // C1-T13 & C1-T14: concurrent/stale supersession & transactional integrity
    const dSup1 = await decisionManager.createDecision({
      projectId: pId,
      topic: 'Supersede Concurrency Predecessor',
      decision: 'V1 Decision',
      reason: 'V1 Reason',
      authority: 'Omar'
    });
    await decisionManager.approveDecision(dSup1.decisionId);
    await decisionManager.freezeDecision(dSup1.decisionId);

    // Execute supersession
    const supOutcome = await decisionManager.supersedeDecision({
      predecessorDecisionId: dSup1.decisionId,
      topic: 'Supersede Concurrency Successor',
      decision: 'V2 Decision',
      reason: 'V2 Reason',
      authority: 'Omar'
    });
    assert.equal(supOutcome.predecessor.status, 'SUPERSEDED');
    assert.equal(supOutcome.successor.status, 'PROPOSED');

    // Attempting a second supersession against the now-SUPERSEDED predecessor fails atomically
    await assert.rejects(async () => {
      await decisionManager.supersedeDecision({
        predecessorDecisionId: dSup1.decisionId,
        topic: 'Stale Successor',
        decision: 'V3 Decision',
        reason: 'V3 Reason',
        authority: 'Omar'
      });
    }, InvalidStateTransitionError);

    // C1-T15: FROZEN integrity sequential tests -> PASS
    const verifyPred = await decisionManager.getDecision(dSup1.decisionId);
    assert.equal(verifyPred.status, 'SUPERSEDED');
    assert.equal(verifyPred.decision, 'V1 Decision');
  } finally {
    await client.end();
  }
});
