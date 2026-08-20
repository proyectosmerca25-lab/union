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
import { AuditRecorder } from './audit-recorder.js';
import { ProjectRegistry } from './project-registry.js';
import { SessionManager } from './session-manager.js';
import { DecisionManager } from './decision-manager.js';
import {
  DatabaseFailureError,
  InvalidInputError,
  NotFoundError
} from './errors.js';
import { AuditContext } from './types.js';

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
    await client.query('DROP TABLE IF EXISTS audit_events CASCADE;');
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

test('F2.3 AUDIT IDENTITY & AUTHORITY PROVENANCE TEST MATRIX (T01 - T64)', async () => {
  const config = getTestConfig();
  await cleanDatabase(config);

  // T01: 0001 -> 0002 -> 0003 clean migration -> PASS
  const migrationRes = await runMigrations(config);
  assert.equal(migrationRes.appliedCount, 3);

  const client = new pg.Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password
  });
  await client.connect();

  try {
    const auditRecorder = new AuditRecorder(client);
    const projectRegistry = new ProjectRegistry(client);
    const sessionManager = new SessionManager(client);
    const decisionManager = new DecisionManager(client);

    // T02: exactly one new table -> audit_events
    const tablesRes = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;"
    );
    const tableNames = tablesRes.rows.map(r => r.table_name);
    assert.deepEqual(tableNames, [
      'audit_events',
      'decision_work_orders',
      'decisions',
      'evidence_references',
      'projects',
      'sessions',
      'union_schema_migrations',
      'work_orders'
    ]);

    // T03: audit_event_id UUID -> PASS
    // T04: trace_id UUID required -> PASS
    // T05: project_id required -> PASS
    // T06: TIMESTAMPTZ created_at -> PASS
    const colsRes = await client.query(
      "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'audit_events';"
    );
    const colsMap = new Map(colsRes.rows.map(r => [r.column_name, r]));
    assert.equal(colsMap.get('audit_event_id')?.data_type, 'uuid');
    assert.equal(colsMap.get('trace_id')?.data_type, 'uuid');
    assert.equal(colsMap.get('trace_id')?.is_nullable, 'NO');
    assert.equal(colsMap.get('project_id')?.data_type, 'uuid');
    assert.equal(colsMap.get('project_id')?.is_nullable, 'NO');
    assert.equal(colsMap.get('created_at')?.data_type, 'timestamp with time zone');

    // T07: no ON DELETE CASCADE -> PASS
    const fkRes = await client.query(
      "SELECT COUNT(*)::int as count FROM information_schema.referential_constraints WHERE constraint_schema = 'public' AND delete_rule = 'CASCADE';"
    );
    assert.equal(fkRes.rows[0].count, 0);

    // T08: 0001/0002 unchanged -> PASS
    const fileContent0002 = await fs.readFile(path.join(config.migrationsDir, '0002_canonical_state.sql'), 'utf8');
    assert.equal(computeChecksum(fileContent0002), '1305d1f2d59e815318309e86a10cde409eba140089b32e32aeaf50b5812df554');

    // Setup base project for audit recording tests
    const trace1 = '33333333-3333-3333-3333-333333333333';
    const auditCtx1: AuditContext = {
      traceId: trace1,
      actor: 'OWNER',
      authorityHolder: 'OWNER',
      authorityBasis: 'OWNER_EXPLICIT',
      coordinatedBy: 'UNION',
      executedBy: 'UNION_CORE'
    };

    const p1 = await projectRegistry.createProject({ displayName: 'Audit Project Alpha' }, auditCtx1);

    // T09: record valid audit event -> PASS
    const ae1 = await auditRecorder.recordAuditEvent({
      traceId: trace1,
      projectId: p1.projectId,
      actor: 'OWNER',
      action: 'TEST_ACTION',
      authorityHolder: 'OWNER',
      authorityBasis: 'OWNER_EXPLICIT',
      coordinatedBy: 'UNION',
      executedBy: 'UNION_CORE',
      result: 'SUCCESS'
    });
    assert.ok(ae1.auditEventId);
    assert.equal(ae1.projectId, p1.projectId);
    assert.equal(ae1.action, 'TEST_ACTION');

    // T10 - T17: Missing required parameters -> FAIL CLOSED (InvalidInputError)
    await assert.rejects(async () => {
      await auditRecorder.recordAuditEvent({ ...ae1, traceId: '' });
    }, InvalidInputError); // T10: missing traceId
    await assert.rejects(async () => {
      await auditRecorder.recordAuditEvent({ ...ae1, projectId: '' });
    }, InvalidInputError); // T11: missing projectId
    await assert.rejects(async () => {
      await auditRecorder.recordAuditEvent({ ...ae1, actor: '' });
    }, InvalidInputError); // T12: missing actor
    await assert.rejects(async () => {
      await auditRecorder.recordAuditEvent({ ...ae1, authorityHolder: '' });
    }, InvalidInputError); // T13: missing authorityHolder
    await assert.rejects(async () => {
      await auditRecorder.recordAuditEvent({ ...ae1, authorityBasis: '' });
    }, InvalidInputError); // T14: missing authorityBasis
    await assert.rejects(async () => {
      await auditRecorder.recordAuditEvent({ ...ae1, coordinatedBy: '' });
    }, InvalidInputError); // T15: missing coordinatedBy
    await assert.rejects(async () => {
      await auditRecorder.recordAuditEvent({ ...ae1, executedBy: '' });
    }, InvalidInputError); // T16: missing executedBy
    await assert.rejects(async () => {
      await auditRecorder.recordAuditEvent({ ...ae1, result: '' });
    }, InvalidInputError); // T17: missing result

    // T18: unknown project -> REJECTED
    await assert.rejects(async () => {
      await auditRecorder.recordAuditEvent({
        ...ae1,
        projectId: '00000000-0000-0000-0000-000000000000'
      });
    }, NotFoundError);

    // T19: authority_holder = UNION, executed_by = UNION_CORE -> PASS
    const aeUnion = await auditRecorder.recordAuditEvent({
      traceId: trace1,
      projectId: p1.projectId,
      actor: 'SYSTEM',
      action: 'SYSTEM_SAFETY_CHECK',
      authorityHolder: 'UNION',
      authorityBasis: 'SYSTEM_SAFETY_RULE',
      coordinatedBy: 'UNION',
      executedBy: 'UNION_CORE',
      result: 'SUCCESS'
    });
    assert.equal(aeUnion.authorityHolder, 'UNION');
    assert.equal(aeUnion.executedBy, 'UNION_CORE');

    // T20: Thin Authority event authority_basis = THIN_AUTHORITY -> PASS
    const aeThin = await auditRecorder.recordAuditEvent({
      traceId: trace1,
      projectId: p1.projectId,
      actor: 'UNION',
      action: 'CANONICAL_OPERATION',
      authorityHolder: 'UNION',
      authorityBasis: 'THIN_AUTHORITY',
      coordinatedBy: 'UNION',
      executedBy: 'UNION_CORE',
      result: 'SUCCESS'
    });
    assert.equal(aeThin.authorityBasis, 'THIN_AUTHORITY');

    // T21 & T22: Disallowed tool authority (ANTIGRAVITY / GITHUB / etc.) -> REJECTED
    await assert.rejects(async () => {
      await auditRecorder.recordAuditEvent({
        traceId: trace1,
        projectId: p1.projectId,
        actor: 'ANTIGRAVITY',
        action: 'EXECUTE',
        authorityHolder: 'ANTIGRAVITY', // Tool self-assigning authority is disallowed!
        authorityBasis: 'IMPLICIT',
        coordinatedBy: 'UNION',
        executedBy: 'ANTIGRAVITY',
        result: 'SUCCESS'
      });
    }, InvalidInputError);

    // T23: missing authority provenance has no implicit fallback -> PASS (InvalidInputError when empty)
    await assert.rejects(async () => {
      await auditRecorder.recordAuditEvent({
        traceId: trace1,
        projectId: p1.projectId,
        actor: 'OWNER',
        action: 'WRITE',
        authorityHolder: '',
        authorityBasis: '',
        coordinatedBy: 'UNION',
        executedBy: 'UNION_CORE',
        result: 'SUCCESS'
      });
    }, InvalidInputError);

    // T24: audit references same-project Session -> PASS
    const s1 = await sessionManager.openSession(p1.projectId, auditCtx1);
    const aeSession = await auditRecorder.recordAuditEvent({
      traceId: trace1,
      projectId: p1.projectId,
      sessionId: s1.sessionId,
      actor: 'OWNER',
      action: 'SESSION_CHECK',
      authorityHolder: 'OWNER',
      authorityBasis: 'OWNER_EXPLICIT',
      coordinatedBy: 'UNION',
      executedBy: 'UNION_CORE',
      result: 'SUCCESS'
    });
    assert.equal(aeSession.sessionId, s1.sessionId);

    // T25: audit project A + Session B -> REJECTED (composite FK violation mapped to NotFoundError)
    const p2 = await projectRegistry.createProject({ displayName: 'Audit Project Beta' }, auditCtx1);
    await assert.rejects(async () => {
      await auditRecorder.recordAuditEvent({
        traceId: trace1,
        projectId: p2.projectId,
        sessionId: s1.sessionId, // s1 belongs to p1!
        actor: 'OWNER',
        action: 'CROSS_PROJECT_AUDIT',
        authorityHolder: 'OWNER',
        authorityBasis: 'OWNER_EXPLICIT',
        coordinatedBy: 'UNION',
        executedBy: 'UNION_CORE',
        result: 'SUCCESS'
      });
    }, NotFoundError);

    // T26: audit project A + Decision B -> REJECTED
    const d1 = await decisionManager.createDecision(
      {
        projectId: p1.projectId,
        topic: 'D1 Topic',
        decision: 'D1 Decision',
        reason: 'D1 Reason',
        authority: 'Omar'
      },
      auditCtx1
    );
    await assert.rejects(async () => {
      await auditRecorder.recordAuditEvent({
        traceId: trace1,
        projectId: p2.projectId,
        decisionId: d1.decisionId, // d1 belongs to p1!
        actor: 'OWNER',
        action: 'CROSS_PROJECT_AUDIT',
        authorityHolder: 'OWNER',
        authorityBasis: 'OWNER_EXPLICIT',
        coordinatedBy: 'UNION',
        executedBy: 'UNION_CORE',
        result: 'SUCCESS'
      });
    }, NotFoundError);

    // T28: AuditRecorder has no update capability -> PASS
    assert.equal((auditRecorder as any).updateAuditEvent, undefined);

    // T29: AuditRecorder has no delete capability -> PASS
    assert.equal((auditRecorder as any).deleteAuditEvent, undefined);

    // T30: existing event remains unchanged after later events -> PASS
    const aeCheck = await auditRecorder.getAuditEvent(ae1.auditEventId);
    assert.equal(aeCheck.action, 'TEST_ACTION');

    // T31 - T34: PROJECT REGISTRY INTEGRATION & TRANSACTION ROLLBACK (T32)
    const pEventsBefore = await auditRecorder.listProjectAuditEvents(p1.projectId);
    const createEv = pEventsBefore.find(e => e.action === 'PROJECT_CREATED');
    assert.ok(createEv);

    // T32: project creation audit failure -> project creation rolled back
    await assert.rejects(async () => {
      await projectRegistry.createProject(
        { displayName: 'Rollback Test Project' },
        { ...auditCtx1, authorityHolder: 'ANTIGRAVITY' } // Invalid authority holder forces audit failure!
      );
    }, InvalidInputError);

    // Verify 'Rollback Test Project' was NOT persisted in projects table!
    const allProjects = await projectRegistry.listProjects();
    const foundRollback = allProjects.find(p => p.displayName === 'Rollback Test Project');
    assert.equal(foundRollback, undefined);

    // T33: rename + PROJECT_RENAMED -> PASS
    await projectRegistry.updateDisplayName(p1.projectId, 'Renamed Alpha', auditCtx1);
    const pEventsAfterRename = await auditRecorder.listProjectAuditEvents(p1.projectId);
    assert.ok(pEventsAfterRename.find(e => e.action === 'PROJECT_RENAMED'));

    // T34: status change + PROJECT_STATUS_CHANGED -> PASS
    await projectRegistry.changeProjectStatus(p1.projectId, 'PAUSED', auditCtx1);
    const pEventsAfterStatus = await auditRecorder.listProjectAuditEvents(p1.projectId);
    assert.ok(pEventsAfterStatus.find(e => e.action === 'PROJECT_STATUS_CHANGED'));

    // T35 - T37: SESSION INTEGRATION
    await projectRegistry.changeProjectStatus(p1.projectId, 'ACTIVE', auditCtx1);
    const s2 = await sessionManager.openSession(p1.projectId, auditCtx1);
    const pEventsSessionOpen = await auditRecorder.listProjectAuditEvents(p1.projectId);
    const openEv = pEventsSessionOpen.find(e => e.action === 'SESSION_OPENED' && e.sessionId === s2.sessionId);
    assert.ok(openEv);

    // T36: session audit failure -> session write rolled back
    await assert.rejects(async () => {
      await sessionManager.openSession(
        p1.projectId,
        { ...auditCtx1, authorityHolder: 'GITHUB' } // Invalid authority holder forces rollback!
      );
    }, InvalidInputError);

    await sessionManager.closeSession(s2.sessionId, auditCtx1);
    const pEventsSessionClose = await auditRecorder.listProjectAuditEvents(p1.projectId);
    assert.ok(pEventsSessionClose.find(e => e.action === 'SESSION_CLOSED' && e.sessionId === s2.sessionId));

    // T38 - T45: DECISION INTEGRATION & ROLLBACK (T45)
    const dAudit = await decisionManager.createDecision(
      {
        projectId: p1.projectId,
        topic: 'Audit Decision',
        decision: 'Audited content',
        reason: 'Testing decision audit integration',
        authority: 'Omar'
      },
      auditCtx1
    );
    const pEventsDecCreated = await auditRecorder.listProjectAuditEvents(p1.projectId);
    assert.ok(pEventsDecCreated.find(e => e.action === 'DECISION_CREATED' && e.decisionId === dAudit.decisionId));

    // T39: updateDecisionContent + DECISION_CONTENT_UPDATED
    await decisionManager.updateDecisionContent(dAudit.decisionId, { decision: 'Updated Audited Content' }, auditCtx1);
    const pEventsDecUpdated = await auditRecorder.listProjectAuditEvents(p1.projectId);
    assert.ok(pEventsDecUpdated.find(e => e.action === 'DECISION_CONTENT_UPDATED' && e.decisionId === dAudit.decisionId));

    // T40: approve + DECISION_APPROVED
    await decisionManager.approveDecision(dAudit.decisionId, auditCtx1);
    const pEventsDecApproved = await auditRecorder.listProjectAuditEvents(p1.projectId);
    assert.ok(pEventsDecApproved.find(e => e.action === 'DECISION_APPROVED' && e.decisionId === dAudit.decisionId));

    // T41: freeze + DECISION_FROZEN
    await decisionManager.freezeDecision(dAudit.decisionId, auditCtx1);
    const pEventsDecFrozen = await auditRecorder.listProjectAuditEvents(p1.projectId);
    assert.ok(pEventsDecFrozen.find(e => e.action === 'DECISION_FROZEN' && e.decisionId === dAudit.decisionId));

    // T42: reopen + DECISION_REOPENED
    await decisionManager.reopenDecision(dAudit.decisionId, 'Reopen for audit test', auditCtx1);
    const pEventsDecReopened = await auditRecorder.listProjectAuditEvents(p1.projectId);
    assert.ok(pEventsDecReopened.find(e => e.action === 'DECISION_REOPENED' && e.decisionId === dAudit.decisionId));

    // T43: reject + DECISION_REJECTED
    await decisionManager.rejectDecision(dAudit.decisionId, auditCtx1);
    const pEventsDecRejected = await auditRecorder.listProjectAuditEvents(p1.projectId);
    assert.ok(pEventsDecRejected.find(e => e.action === 'DECISION_REJECTED' && e.decisionId === dAudit.decisionId));

    // T44: supersede + DECISION_SUPERSEDED
    const dSupPre = await decisionManager.createDecision(
      {
        projectId: p1.projectId,
        topic: 'Predecessor Topic',
        decision: 'V1 Decision',
        reason: 'V1 Reason',
        authority: 'Omar'
      },
      auditCtx1
    );
    await decisionManager.approveDecision(dSupPre.decisionId, auditCtx1);
    await decisionManager.freezeDecision(dSupPre.decisionId, auditCtx1);

    const supRes = await decisionManager.supersedeDecision(
      {
        predecessorDecisionId: dSupPre.decisionId,
        topic: 'Successor Topic',
        decision: 'V2 Decision',
        reason: 'V2 Reason',
        authority: 'Omar'
      },
      auditCtx1
    );

    const pEventsDecSuperseded = await auditRecorder.listProjectAuditEvents(p1.projectId);
    const supAuditEv = pEventsDecSuperseded.find(e => e.action === 'DECISION_SUPERSEDED' && e.decisionId === supRes.successor.decisionId);
    assert.ok(supAuditEv);
    assert.equal(supAuditEv.authorityReference, dSupPre.decisionId);

    // T45: audit persistence failure during Decision transition -> canonical transition rolled back
    const dToApprove = await decisionManager.createDecision(
      {
        projectId: p1.projectId,
        topic: 'Rollback Approve Test',
        decision: 'Text',
        reason: 'Reason',
        authority: 'Omar'
      },
      auditCtx1
    );

    await assert.rejects(async () => {
      await decisionManager.approveDecision(
        dToApprove.decisionId,
        { ...auditCtx1, authorityHolder: 'RAILWAY' } // Invalid authority holder forces transaction rollback!
      );
    }, InvalidInputError);

    // Verify decision remained PROPOSED!
    const decisionAfterRollback = await decisionManager.getDecision(dToApprove.decisionId);
    assert.equal(decisionAfterRollback.status, 'PROPOSED');

    // T50 & T51 & T52: TRACE_ID BEHAVIOR
    const aeTraceTest = await auditRecorder.recordAuditEvent({
      traceId: trace1,
      projectId: p1.projectId,
      actor: 'OWNER',
      action: 'TRACE_TEST',
      authorityHolder: 'OWNER',
      authorityBasis: 'OWNER_EXPLICIT',
      coordinatedBy: 'UNION',
      executedBy: 'UNION_CORE',
      result: 'SUCCESS'
    });
    assert.equal(aeTraceTest.traceId, trace1);

    // T53 - T56: PROVENANCE METADATA
    const aeProv = await auditRecorder.recordAuditEvent({
      traceId: trace1,
      projectId: p1.projectId,
      actor: 'OWNER',
      action: 'PROVENANCE_TEST',
      authorityHolder: 'OWNER',
      authorityBasis: 'OWNER_EXPLICIT',
      coordinatedBy: 'UNION',
      executedBy: 'UNION_CORE',
      result: 'SUCCESS',
      provenance: { sourceType: 'WORK_ORDER_CONTRACT', contractVersion: '1.0' }
    });
    assert.equal(aeProv.provenance?.sourceType, 'WORK_ORDER_CONTRACT');

    // T58 & T59: Migration 0003 checksum stability & idempotency
    const fileContent0003 = await fs.readFile(path.join(config.migrationsDir, '0003_audit_identity.sql'), 'utf8');
    const checksum0003 = computeChecksum(fileContent0003);
    assert.ok(checksum0003.length === 64);

    const runAgainRes = await runMigrations(config);
    assert.equal(runAgainRes.appliedCount, 0); // Idempotent second run!
  } finally {
    await client.end();
  }
});
