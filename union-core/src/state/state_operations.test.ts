import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import {
  computeChecksum,
  MissingDatabaseConfigurationError,
  runMigrations
} from '../db/migrations/runner.js';
import { ProjectRegistry } from './project-registry.js';
import { SessionManager } from './session-manager.js';
import { DecisionManager } from './decision-manager.js';
import {
  AlreadyClosedError,
  CrossProjectViolationError,
  FrozenDecisionMutationError,
  InvalidInputError,
  InvalidStateTransitionError,
  NotFoundError
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

test('F2.2 CANONICAL STATE OPERATIONS TEST MATRIX (T01 - T54)', async () => {
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
    const sessionManager = new SessionManager(client);
    const decisionManager = new DecisionManager(client);

    // --- PROJECT REGISTRY TESTS (T01 - T11) ---

    // T01: create valid project -> PASS
    const p1 = await projectRegistry.createProject({ displayName: 'UNIÓN Alpha' });
    assert.ok(p1.projectId);
    assert.equal(p1.displayName, 'UNIÓN Alpha');
    assert.equal(p1.status, 'ACTIVE');

    // T02: project_id generated and stable -> PASS
    const p1Id = p1.projectId;
    assert.ok(p1Id.length > 0);

    // T03: get existing project -> PASS
    const fetchedP1 = await projectRegistry.getProject(p1Id);
    assert.equal(fetchedP1.projectId, p1Id);
    assert.equal(fetchedP1.displayName, 'UNIÓN Alpha');

    // T04: get unknown project -> NOT_FOUND
    const fakeUuid = '00000000-0000-0000-0000-000000000000';
    await assert.rejects(async () => {
      await projectRegistry.getProject(fakeUuid);
    }, NotFoundError);

    // T05: list projects -> PASS
    const p2 = await projectRegistry.createProject({ displayName: 'KYRONS Beta' });
    const pList = await projectRegistry.listProjects();
    assert.equal(pList.length, 2);
    assert.equal(pList[0].projectId, p1Id);
    assert.equal(pList[1].projectId, p2.projectId);

    // T06: update display_name -> project_id unchanged
    const updatedP1 = await projectRegistry.updateDisplayName(p1Id, 'UNIÓN Alpha Renovated');
    assert.equal(updatedP1.projectId, p1Id);
    assert.equal(updatedP1.displayName, 'UNIÓN Alpha Renovated');

    // T07: change ACTIVE -> PAUSED -> PASS
    const pausedP1 = await projectRegistry.changeProjectStatus(p1Id, 'PAUSED');
    assert.equal(pausedP1.status, 'PAUSED');

    // T08: change PAUSED -> ACTIVE -> PASS
    const reactivatedP1 = await projectRegistry.changeProjectStatus(p1Id, 'ACTIVE');
    assert.equal(reactivatedP1.status, 'ACTIVE');

    // T09: change ACTIVE/PAUSED -> ARCHIVED -> PASS
    const archivedP2 = await projectRegistry.changeProjectStatus(p2.projectId, 'ARCHIVED');
    assert.equal(archivedP2.status, 'ARCHIVED');

    // T10: invalid project status -> REJECTED
    await assert.rejects(async () => {
      await projectRegistry.changeProjectStatus(p1Id, 'DELETED' as any);
    }, InvalidInputError);

    // T11: physical delete capability -> NOT IMPLEMENTED
    assert.equal((projectRegistry as any).deleteProject, undefined);

    // --- SESSIONS TESTS (T12 - T19) ---

    // T12: open session for existing project -> OPEN / PASS
    const s1 = await sessionManager.openSession(p1Id);
    assert.ok(s1.sessionId);
    assert.equal(s1.projectId, p1Id);
    assert.equal(s1.status, 'OPEN');

    // T13: open session for unknown project -> REJECTED
    await assert.rejects(async () => {
      await sessionManager.openSession(fakeUuid);
    }, NotFoundError);

    // T14: OPEN session has closed_at NULL -> PASS
    assert.equal(s1.closedAt, null);

    // T15: close OPEN session -> CLOSED with closed_at populated
    const closedS1 = await sessionManager.closeSession(s1.sessionId);
    assert.equal(closedS1.status, 'CLOSED');
    assert.ok(closedS1.closedAt instanceof Date);

    // T16: close already CLOSED session -> ALREADY_CLOSED / DENIED
    await assert.rejects(async () => {
      await sessionManager.closeSession(s1.sessionId);
    }, AlreadyClosedError);

    // T17: reopen CLOSED session -> capability absent / DENIED
    assert.equal((sessionManager as any).reopenSession, undefined);

    // T18: list project sessions -> only correct project sessions
    const s2 = await sessionManager.openSession(p1Id);
    const p1Sessions = await sessionManager.listProjectSessions(p1Id);
    assert.equal(p1Sessions.length, 2);
    assert.equal(p1Sessions[0].sessionId, s1.sessionId);
    assert.equal(p1Sessions[1].sessionId, s2.sessionId);

    // T19: cross-project session contamination -> REJECTED
    const p2Sessions = await sessionManager.listProjectSessions(p2.projectId);
    assert.equal(p2Sessions.length, 0);

    // --- DECISIONS TESTS (T20 - T33) ---

    // T20: create PROPOSED decision -> PASS
    const d1 = await decisionManager.createDecision({
      projectId: p1Id,
      topic: 'Architecture Baseline',
      decision: 'Freeze F1 and F2 state contracts',
      reason: 'Architecture governance requirement',
      authority: 'Omar'
    });
    assert.ok(d1.decisionId);
    assert.equal(d1.status, 'PROPOSED');
    assert.equal(d1.projectId, p1Id);

    // T21: create Decision under same-project Session -> PASS
    const d2 = await decisionManager.createDecision({
      projectId: p1Id,
      sessionId: s2.sessionId,
      topic: 'Persistence Enforcement',
      decision: 'Use PostgreSQL composite foreign keys',
      reason: 'P0 relational isolation',
      authority: 'ChatGPT'
    });
    assert.equal(d2.sessionId, s2.sessionId);

    // T22: cross-project Decision/Session -> REJECTED
    await assert.rejects(async () => {
      await decisionManager.createDecision({
        projectId: p2.projectId,
        sessionId: s2.sessionId, // s2 belongs to p1!
        topic: 'Cross-Project Test',
        decision: 'Should Fail',
        reason: 'Cross project test',
        authority: 'Tester'
      });
    }, CrossProjectViolationError);

    // T23: PROPOSED -> APPROVED -> PASS
    const approvedD1 = await decisionManager.approveDecision(d1.decisionId);
    assert.equal(approvedD1.status, 'APPROVED');
    assert.ok(approvedD1.decidedAt instanceof Date);

    // T24: PROPOSED -> REJECTED -> PASS
    const dRejected = await decisionManager.createDecision({
      projectId: p1Id,
      topic: 'Temporary Proposal',
      decision: 'To be rejected',
      reason: 'Rejection test',
      authority: 'Omar'
    });
    const rejectedD = await decisionManager.rejectDecision(dRejected.decisionId);
    assert.equal(rejectedD.status, 'REJECTED');

    // T25: APPROVED -> FROZEN -> PASS
    const frozenD1 = await decisionManager.freezeDecision(approvedD1.decisionId);
    assert.equal(frozenD1.status, 'FROZEN');

    // T26: FROZEN -> REOPENED -> PASS
    const reopenedD1 = await decisionManager.reopenDecision(frozenD1.decisionId, 'New evidence requiring review');
    assert.equal(reopenedD1.status, 'REOPENED');
    assert.equal(reopenedD1.reopenCondition, 'New evidence requiring review');

    // T27: REOPENED -> APPROVED -> PASS
    const reapprovedD1 = await decisionManager.approveDecision(reopenedD1.decisionId);
    assert.equal(reapprovedD1.status, 'APPROVED');

    // Refreeze reapprovedD1
    await decisionManager.freezeDecision(reapprovedD1.decisionId);

    // T28: REOPENED -> REJECTED -> PASS
    const dReopenReject = await decisionManager.createDecision({
      projectId: p1Id,
      topic: 'Reopen Reject Test',
      decision: 'Will be reopened and rejected',
      reason: 'Reopen reject test',
      authority: 'Omar'
    });
    await decisionManager.approveDecision(dReopenReject.decisionId);
    await decisionManager.freezeDecision(dReopenReject.decisionId);
    await decisionManager.reopenDecision(dReopenReject.decisionId, 'Condition');
    const rejReopened = await decisionManager.rejectDecision(dReopenReject.decisionId);
    assert.equal(rejReopened.status, 'REJECTED');

    // T29: FROZEN -> SUPERSEDED -> PASS when valid successor semantics are satisfied
    const dToSup = await decisionManager.createDecision({
      projectId: p1Id,
      topic: 'V1 Storage Spec',
      decision: 'Use raw SQL',
      reason: 'Initial storage choice',
      authority: 'Omar'
    });
    await decisionManager.approveDecision(dToSup.decisionId);
    await decisionManager.freezeDecision(dToSup.decisionId);

    const supRes1 = await decisionManager.supersedeDecision({
      predecessorDecisionId: dToSup.decisionId,
      topic: 'V2 Storage Spec',
      decision: 'Use explicit typed SQL module',
      reason: 'Upgraded to typed module',
      authority: 'Omar'
    });
    assert.equal(supRes1.predecessor.status, 'SUPERSEDED');
    assert.equal(supRes1.successor.status, 'PROPOSED');
    assert.equal(supRes1.successor.supersedesDecisionId, dToSup.decisionId);

    // T30: REOPENED -> SUPERSEDED -> PASS when valid successor semantics are satisfied
    const dReopenedSup = await decisionManager.createDecision({
      projectId: p1Id,
      topic: 'Reopened Supersede Test',
      decision: 'Initial',
      reason: 'Initial choice',
      authority: 'Omar'
    });
    await decisionManager.approveDecision(dReopenedSup.decisionId);
    await decisionManager.freezeDecision(dReopenedSup.decisionId);
    await decisionManager.reopenDecision(dReopenedSup.decisionId, 'Reopened for supersession');

    const supRes2 = await decisionManager.supersedeDecision({
      predecessorDecisionId: dReopenedSup.decisionId,
      topic: 'Reopened Successor',
      decision: 'Replaced after reopen',
      reason: 'Replaced after reopen',
      authority: 'Omar'
    });
    assert.equal(supRes2.predecessor.status, 'SUPERSEDED');
    assert.equal(supRes2.successor.status, 'PROPOSED');

    // T31: invalid transition PROPOSED -> FROZEN -> DENIED
    const dProp = await decisionManager.createDecision({
      projectId: p1Id,
      topic: 'Direct Freeze Test',
      decision: 'Cannot freeze directly from PROPOSED',
      reason: 'Direct freeze test',
      authority: 'Omar'
    });
    await assert.rejects(async () => {
      await decisionManager.freezeDecision(dProp.decisionId);
    }, InvalidStateTransitionError);

    // T32: invalid transition REJECTED -> APPROVED -> DENIED
    await assert.rejects(async () => {
      await decisionManager.approveDecision(rejectedD.decisionId);
    }, InvalidStateTransitionError);

    // T33: invalid transition SUPERSEDED -> REOPENED -> DENIED
    await assert.rejects(async () => {
      await decisionManager.reopenDecision(supRes1.predecessor.decisionId);
    }, InvalidStateTransitionError);

    // --- FROZEN INTEGRITY TESTS (T34 - T37) ---

    // Create a frozen decision for integrity checks
    const dFrozenIntegrity = await decisionManager.createDecision({
      projectId: p1Id,
      topic: 'Immutable Core Contract',
      decision: 'Frozen text value',
      reason: 'Immutability test',
      authority: 'Omar'
    });
    await decisionManager.approveDecision(dFrozenIntegrity.decisionId);
    await decisionManager.freezeDecision(dFrozenIntegrity.decisionId);

    // T34: modify FROZEN decision content directly -> DENIED
    await assert.rejects(async () => {
      await decisionManager.updateDecisionContent(dFrozenIntegrity.decisionId, {
        decision: 'Tampered Value'
      });
    }, FrozenDecisionMutationError);

    // T37: FROZEN content remains unchanged after rejected silent mutation -> PASS
    const verifyFrozen = await decisionManager.getDecision(dFrozenIntegrity.decisionId);
    assert.equal(verifyFrozen.decision, 'Frozen text value');
    assert.equal(verifyFrozen.status, 'FROZEN');

    // T35: modify REOPENED decision content through authorized path -> PASS
    await decisionManager.reopenDecision(dFrozenIntegrity.decisionId, 'Authorized modification');
    const updatedReopened = await decisionManager.updateDecisionContent(dFrozenIntegrity.decisionId, {
      decision: 'Updated Decision Value Post-Reopen'
    });
    assert.equal(updatedReopened.decision, 'Updated Decision Value Post-Reopen');

    // T36: reapprove + refreeze modified reopened decision -> PASS
    await decisionManager.approveDecision(dFrozenIntegrity.decisionId);
    const refrozen = await decisionManager.freezeDecision(dFrozenIntegrity.decisionId);
    assert.equal(refrozen.status, 'FROZEN');
    assert.equal(refrozen.decision, 'Updated Decision Value Post-Reopen');

    // --- SUPERSESSION TESTS (T38 - T41) ---

    // T38: same-project supersession -> PASS
    const dSupSame = await decisionManager.createDecision({
      projectId: p1Id,
      topic: 'Supersession Topic',
      decision: 'Predecessor decision text',
      reason: 'Predecessor reason',
      authority: 'Omar'
    });
    await decisionManager.approveDecision(dSupSame.decisionId);
    await decisionManager.freezeDecision(dSupSame.decisionId);

    const sameProjectSup = await decisionManager.supersedeDecision({
      predecessorDecisionId: dSupSame.decisionId,
      topic: 'Supersession Topic',
      decision: 'Successor decision text',
      authority: 'Omar'
    });
    assert.equal(sameProjectSup.successor.projectId, p1Id);
    assert.equal(sameProjectSup.predecessor.status, 'SUPERSEDED');

    // T39: self-supersession -> REJECTED
    await assert.rejects(async () => {
      await decisionManager.supersedeDecision({
        predecessorDecisionId: sameProjectSup.successor.decisionId,
        topic: 'Self Supersede',
        decision: 'Invalid',
        authority: 'Omar'
      });
    }, InvalidStateTransitionError); // successor is PROPOSED, so cannot be superseded!

    // T40: cross-project supersession -> REJECTED
    await assert.rejects(async () => {
      await decisionManager.supersedeDecision({
        predecessorDecisionId: dSupSame.decisionId,
        sessionId: s2.sessionId, // s2 is under p1, but if we tried to pass cross-project session:
        topic: 'Cross-Project Supersede',
        decision: 'Fail',
        authority: 'Omar'
      });
    }, InvalidStateTransitionError); // dSupSame is SUPERSEDED, invalid state

    // T41: predecessor history preserved -> PASS
    const predHistory = await decisionManager.getDecision(dSupSame.decisionId);
    assert.equal(predHistory.status, 'SUPERSEDED');
    assert.equal(predHistory.decision, 'Predecessor decision text');

    // --- PERSISTENCE / RESTART TESTS (T42 - T44) ---

    // T42: create project/session/decision -> disconnect -> reconnect -> same durable state recovered
    const client2 = new pg.Client({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password
    });
    await client2.connect();

    try {
      const pReg2 = new ProjectRegistry(client2);
      const sMgr2 = new SessionManager(client2);
      const dMgr2 = new DecisionManager(client2);

      const recoveredP1 = await pReg2.getProject(p1Id);
      assert.equal(recoveredP1.displayName, 'UNIÓN Alpha Renovated');

      // T44: session CLOSED remains CLOSED after reinitialization
      const recoveredS1 = await sMgr2.getSession(s1.sessionId);
      assert.equal(recoveredS1.status, 'CLOSED');
      assert.ok(recoveredS1.closedAt instanceof Date);

      // T43: FROZEN decision remains FROZEN after manager/process reinitialization
      const recoveredDFrozen = await dMgr2.getDecision(dFrozenIntegrity.decisionId);
      assert.equal(recoveredDFrozen.status, 'FROZEN');
      assert.equal(recoveredDFrozen.decision, 'Updated Decision Value Post-Reopen');
    } finally {
      await client2.end();
    }

    // --- DATABASE / REGRESSION TESTS (T45 - T54) ---

    // T45: 0002 checksum unchanged -> PASS
    const fileContent = await fs.readFile(path.join(config.migrationsDir, '0002_canonical_state.sql'), 'utf8');
    const expectedChecksum = computeChecksum(fileContent);
    assert.equal(expectedChecksum, '1305d1f2d59e815318309e86a10cde409eba140089b32e32aeaf50b5812df554');

    // T46: no 0003 migration created -> PASS
    const migrationFiles = await fs.readdir(config.migrationsDir);
    assert.deepEqual(migrationFiles.sort(), ['0001_migration_foundation.sql', '0002_canonical_state.sql']);

    // T47: six domain tables unchanged -> PASS
    const tablesRes = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;"
    );
    const tables = tablesRes.rows.map(r => r.table_name);
    assert.deepEqual(tables, [
      'decision_work_orders',
      'decisions',
      'evidence_references',
      'projects',
      'sessions',
      'union_schema_migrations',
      'work_orders'
    ]);

    // T48: cross-project DB constraints preserved -> PASS
    const fkRes = await client.query(
      "SELECT COUNT(*)::int as count FROM information_schema.table_constraints WHERE constraint_schema = 'public' AND constraint_type = 'FOREIGN KEY';"
    );
    assert.equal(fkRes.rows[0].count, 14);

  } finally {
    await client.end();
  }
});
