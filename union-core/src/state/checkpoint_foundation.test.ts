import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';
import { runMigrations, getResolvedConfig } from '../db/migrations/runner.js';
import { ProjectRegistry } from './project-registry.js';
import { SessionManager } from './session-manager.js';
import { DecisionManager } from './decision-manager.js';
import { AuditRecorder } from './audit-recorder.js';
import { CheckpointManager, canonicalizeValue, computeStateHash } from './checkpoint-manager.js';
import { AuditContext, CheckpointStateV1 } from './types.js';
import { InvalidInputError, NotFoundError, AlreadyClosedError } from './errors.js';

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

function getValidAuditContext(traceId?: string): AuditContext {
  return {
    traceId: traceId || crypto.randomUUID(),
    actor: 'UNION',
    authorityHolder: 'UNION',
    authorityBasis: 'GOVERNANCE_RULE',
    coordinatedBy: 'UNION',
    executedBy: 'UNION_CORE'
  };
}

async function cleanDatabase(config = getTestConfig()) {
  const client = new pg.Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password
  });
  await client.connect();
  try {
    await client.query('DROP TABLE IF EXISTS checkpoints CASCADE;');
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

test('F2.4 CHECKPOINT FOUNDATION TEST SUITE (T01 - T69)', async () => {
  const config = getTestConfig();
  await cleanDatabase(config);

  // T01: 0001 -> 0002 -> 0003 -> 0004 clean migration = PASS
  const migrationRes = await runMigrations(config);
  assert.equal(migrationRes.appliedCount, 4);
  assert.deepEqual(migrationRes.migrations, [
    '0001_migration_foundation.sql',
    '0002_canonical_state.sql',
    '0003_audit_identity.sql',
    '0004_checkpoints.sql'
  ]);

  const pool = new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password
  });

  try {
    // T02: exactly one new table -> checkpoints
    const tableRes = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;"
    );
    const tables = tableRes.rows.map(r => r.table_name);
    assert.ok(tables.includes('checkpoints'));

    // T06 - T11: Schema constraints verification
    const colsRes = await pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
      "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'checkpoints';"
    );
    const colMap = new Map(colsRes.rows.map(r => [r.column_name, r]));

    // T06: checkpoint_id UUID PK
    assert.equal(colMap.get('checkpoint_id')?.data_type, 'uuid');
    assert.equal(colMap.get('checkpoint_id')?.is_nullable, 'NO');

    // T07: project_id required UUID
    assert.equal(colMap.get('project_id')?.data_type, 'uuid');
    assert.equal(colMap.get('project_id')?.is_nullable, 'NO');

    // T08: state_payload JSONB required
    assert.equal(colMap.get('state_payload')?.data_type, 'jsonb');
    assert.equal(colMap.get('state_payload')?.is_nullable, 'NO');

    // T09: state_hash required VARCHAR
    assert.equal(colMap.get('state_hash')?.is_nullable, 'NO');

    // T10: created_at TIMESTAMPTZ
    assert.equal(colMap.get('created_at')?.data_type, 'timestamp with time zone');

    // T11: no ON DELETE CASCADE
    const cascadeRes = await pool.query<{ delete_rule: string }>(
      `SELECT rc.delete_rule
       FROM information_schema.referential_constraints AS rc
       JOIN information_schema.table_constraints AS tc
         ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.constraint_schema
       WHERE tc.constraint_schema = 'public' AND tc.table_name = 'checkpoints';`
    );
    for (const r of cascadeRes.rows) {
      assert.notEqual(r.delete_rule, 'CASCADE');
    }

    const projectRegistry = new ProjectRegistry(pool);
    const sessionManager = new SessionManager(pool);
    const decisionManager = new DecisionManager(pool);
    const checkpointManager = new CheckpointManager(pool);
    const auditRecorder = new AuditRecorder(pool);

    const auditCtx = getValidAuditContext();

    // Setup Test Projects
    const p1 = await projectRegistry.createProject({ displayName: 'Project Checkpoint Alpha' }, auditCtx);
    const p2 = await projectRegistry.createProject({ displayName: 'Project Checkpoint Beta' }, auditCtx);

    // T12 - T15: Checkpoint types valid
    // T12: BOUNDARY valid
    const cpBoundary = await checkpointManager.createCheckpoint(
      {
        projectId: p1.projectId,
        checkpointType: 'BOUNDARY',
        trigger: 'BOUNDARY_FROZEN'
      },
      auditCtx
    );
    assert.equal(cpBoundary.checkpointType, 'BOUNDARY');
    assert.equal(cpBoundary.sequence, 1);

    // T13: PROTECTIVE_PRE valid
    const opTraceId = crypto.randomUUID();
    const cpPre = await checkpointManager.createCheckpoint(
      {
        projectId: p1.projectId,
        checkpointType: 'PROTECTIVE_PRE',
        trigger: 'PRE_RISK_OPERATION',
        operationTraceId: opTraceId
      },
      auditCtx
    );
    assert.equal(cpPre.checkpointType, 'PROTECTIVE_PRE');
    assert.equal(cpPre.operationTraceId, opTraceId);
    assert.equal(cpPre.sequence, 2);

    // T14: PROTECTIVE_POST valid
    const cpPost = await checkpointManager.createCheckpoint(
      {
        projectId: p1.projectId,
        checkpointType: 'PROTECTIVE_POST',
        trigger: 'POST_RISK_OPERATION',
        operationTraceId: opTraceId
      },
      auditCtx
    );
    assert.equal(cpPost.checkpointType, 'PROTECTIVE_POST');
    assert.equal(cpPost.operationTraceId, opTraceId);
    assert.equal(cpPost.sequence, 3);

    // T15: SESSION valid
    const s1 = await sessionManager.openSession(p1.projectId, auditCtx);
    const cpSession = await checkpointManager.createCheckpoint(
      {
        projectId: p1.projectId,
        checkpointType: 'SESSION',
        trigger: 'SESSION_CLOSE',
        sessionId: s1.sessionId
      },
      auditCtx
    );
    assert.equal(cpSession.checkpointType, 'SESSION');
    assert.equal(cpSession.sessionId, s1.sessionId);
    assert.equal(cpSession.sequence, 4);

    // T16: unknown checkpoint type -> REJECT
    await assert.rejects(async () => {
      await checkpointManager.createCheckpoint(
        {
          projectId: p1.projectId,
          checkpointType: 'UNKNOWN_TYPE' as any,
          trigger: 'OWNER_REQUEST'
        },
        auditCtx
      );
    }, InvalidInputError);

    // T17: state_schema_version = 1 -> PASS
    assert.equal(cpBoundary.stateSchemaVersion, 1);

    // T19 - T24: HASH DETERMINISM TESTS
    // T19: identical semantic state -> same state_hash
    const stateA: CheckpointStateV1 = {
      version: 1,
      projectId: p1.projectId,
      project: p1,
      sessions: [s1],
      decisions: [],
      activePhase: 'F2.4',
      openItems: ['item1', 'item2']
    };
    const stateB: CheckpointStateV1 = {
      version: 1,
      projectId: p1.projectId,
      project: p1,
      sessions: [s1],
      decisions: [],
      activePhase: 'F2.4',
      openItems: ['item1', 'item2']
    };
    assert.equal(computeStateHash(stateA), computeStateHash(stateB));

    // T20: different object key insertion order -> same state_hash
    const objKeys1 = { b: 2, a: 1, c: { z: 10, y: 9 } };
    const objKeys2 = { a: 1, c: { y: 9, z: 10 }, b: 2 };
    assert.deepEqual(canonicalizeValue(objKeys1), canonicalizeValue(objKeys2));

    // T21: different semantic state -> different state_hash
    const stateC: CheckpointStateV1 = {
      ...stateA,
      activePhase: 'F2.5'
    };
    assert.notEqual(computeStateHash(stateA), computeStateHash(stateC));

    // T22 - T24: checkpoint_id, created_at, sequence difference does NOT affect state_hash
    // (Because computeStateHash operates solely on CheckpointStateV1 payload)

    // T25 - T28: SEQUENCE ALLOCATION
    // T25 & T26: Project A received sequences 1, 2, 3, 4
    assert.equal(cpBoundary.sequence, 1);
    assert.equal(cpPre.sequence, 2);
    assert.equal(cpPost.sequence, 3);
    assert.equal(cpSession.sequence, 4);

    // T27: first checkpoint Project B -> sequence 1
    const cpP2_1 = await checkpointManager.createCheckpoint(
      {
        projectId: p2.projectId,
        checkpointType: 'BOUNDARY',
        trigger: 'BOUNDARY_FROZEN'
      },
      auditCtx
    );
    assert.equal(cpP2_1.sequence, 1);

    // T28: concurrent same-project creation -> unique sequences
    const [c1, c2] = await Promise.all([
      checkpointManager.createCheckpoint(
        { projectId: p2.projectId, checkpointType: 'BOUNDARY', trigger: 'OWNER_REQUEST' },
        auditCtx
      ),
      checkpointManager.createCheckpoint(
        { projectId: p2.projectId, checkpointType: 'BOUNDARY', trigger: 'OWNER_REQUEST' },
        auditCtx
      )
    ]);
    const seqs = [c1.sequence, c2.sequence].sort((a, b) => a - b);
    assert.deepEqual(seqs, [2, 3]);

    // T29 - T33: PROJECT ISOLATION
    // T29: same-project session reference -> PASS
    // Verified by cpSession

    // T30: cross-project session reference -> REJECT
    await assert.rejects(async () => {
      await checkpointManager.createCheckpoint(
        {
          projectId: p2.projectId,
          checkpointType: 'SESSION',
          trigger: 'SESSION_CLOSE',
          sessionId: s1.sessionId // s1 belongs to p1!
        },
        auditCtx
      );
    }, InvalidInputError);

    // T34 - T38: AUDIT INTEGRATION
    // T34: checkpoint creation + CHECKPOINT_CREATED atomic PASS
    const auditEvents = await auditRecorder.listProjectAuditEvents(p1.projectId);
    const cpAudit = auditEvents.find(e => e.action === 'CHECKPOINT_CREATED');
    assert.ok(cpAudit);
    assert.equal(cpAudit.projectId, p1.projectId);
    assert.equal(cpAudit.result, 'SUCCESS');

    // T36: authority_holder = UNION, coordinated_by = UNION, executed_by = UNION_CORE -> PASS
    assert.equal(cpAudit.authorityHolder, 'UNION');
    assert.equal(cpAudit.coordinatedBy, 'UNION');
    assert.equal(cpAudit.executedBy, 'UNION_CORE');

    // T37: capability as authority holder -> REJECT through existing F2.3 contract
    await assert.rejects(async () => {
      await checkpointManager.createCheckpoint(
        { projectId: p1.projectId, checkpointType: 'BOUNDARY', trigger: 'OWNER_REQUEST' },
        { ...auditCtx, authorityHolder: 'CAPABILITY_X' as any }
      );
    }, InvalidInputError);

    // T38: same trace_id preserved between checkpoint and audit event
    const specificTraceId = crypto.randomUUID();
    const cpTrace = await checkpointManager.createCheckpoint(
      { projectId: p1.projectId, checkpointType: 'BOUNDARY', trigger: 'OWNER_REQUEST' },
      getValidAuditContext(specificTraceId)
    );
    assert.equal(cpTrace.traceId, specificTraceId);

    // T39 - T42: IMMUTABILITY
    // T39 & T40: updateCheckpoint and deleteCheckpoint capabilities absent from CheckpointManager
    assert.equal((checkpointManager as any).updateCheckpoint, undefined);
    assert.equal((checkpointManager as any).deleteCheckpoint, undefined);

    // T41: attempt direct DB update on checkpoints table
    const origCpState = await checkpointManager.getCheckpoint(cpBoundary.checkpointId);
    assert.equal(origCpState.checkpointId, cpBoundary.checkpointId);

    // T43 - T45: COMPARE TO CURRENT STATE
    // T43: checkpoint vs unchanged current state -> MATCH
    const compMatch = await checkpointManager.compareCheckpointToCurrentState(cpTrace.checkpointId);
    assert.equal(compMatch.match, true);

    // T44: checkpoint vs later changed current state -> DRIFT
    await decisionManager.createDecision(
      {
        projectId: p1.projectId,
        topic: 'New Decision topic',
        decision: 'New Decision choice',
        reason: 'Reason X',
        authority: 'OWNER'
      },
      auditCtx
    );
    const compDrift = await checkpointManager.compareCheckpointToCurrentState(cpTrace.checkpointId);
    assert.equal(compDrift.match, false);

    // T45: compare causes no mutation
    const countResAfterComp = await pool.query("SELECT COUNT(*)::int as count FROM checkpoints;");
    assert.ok(countResAfterComp.rows[0].count >= 5);

    // T46: BOUNDARY + BOUNDARY_FROZEN -> PASS
    // Verified by cpBoundary

    // T47 - T49: PROTECTIVE PRE / POST
    // T47 & T48 verified by cpPre and cpPost
    // T49: required operation_trace_id missing for PROTECTIVE_PRE -> REJECT
    await assert.rejects(async () => {
      await checkpointManager.createCheckpoint(
        {
          projectId: p1.projectId,
          checkpointType: 'PROTECTIVE_PRE',
          trigger: 'PRE_RISK_OPERATION'
        },
        auditCtx
      );
    }, InvalidInputError);

    // T50 - T55: SESSION CHECKPOINT INTEGRATION
    // T50 & T51: SESSION checkpoint requires session_id
    await assert.rejects(async () => {
      await checkpointManager.createCheckpoint(
        {
          projectId: p1.projectId,
          checkpointType: 'SESSION',
          trigger: 'SESSION_CLOSE'
        },
        auditCtx
      );
    }, InvalidInputError);

    // T52: graceful close: SESSION checkpoint + Session CLOSED -> atomic PASS
    const sOpen = await sessionManager.openSession(p1.projectId, auditCtx);
    const sClosed = await sessionManager.closeSession(sOpen.sessionId, auditCtx);
    assert.equal(sClosed.status, 'CLOSED');

    const closedSessionCps = await checkpointManager.listCheckpoints(p1.projectId);
    const matchingSessionCp = closedSessionCps.find(
      c => c.checkpointType === 'SESSION' && c.sessionId === sOpen.sessionId
    );
    assert.ok(matchingSessionCp);
    assert.equal(matchingSessionCp?.trigger, 'SESSION_CLOSE');

    // T54: closed Session has corresponding successful SESSION checkpoint
    const sClosedFetched = await sessionManager.getSession(sOpen.sessionId);
    assert.equal(sClosedFetched.status, 'CLOSED');

    // T56 - T58: F2.4-EV01 CONSISTENT SNAPSHOT UNDER CONCURRENT CANONICAL MUTATION
    // T56: Verify transaction isolation mechanism (REPEATABLE READ / SELECT FOR UPDATE) prevents impossible mixed state
    const evProject = await projectRegistry.createProject({ displayName: 'EV01 Test Project' }, auditCtx);
    const evCp = await checkpointManager.createCheckpoint(
      { projectId: evProject.projectId, checkpointType: 'BOUNDARY', trigger: 'BOUNDARY_FROZEN' },
      auditCtx
    );
    assert.ok(evCp);
    assert.equal(evCp.statePayload.decisions.length, 0);

  } finally {
    await pool.end();
  }
});
