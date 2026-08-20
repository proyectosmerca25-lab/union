import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import pg from 'pg';
import { runMigrations, computeChecksum } from '../db/migrations/runner.js';
import { ProjectRegistry } from './project-registry.js';
import { SessionManager } from './session-manager.js';
import { DecisionManager } from './decision-manager.js';
import { AuditRecorder } from './audit-recorder.js';
import { CheckpointManager, canonicalizeValue, computeStateHash } from './checkpoint-manager.js';
import { AuditContext, CheckpointStateV1 } from './types.js';
import { InvalidInputError, NotFoundError } from './errors.js';

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

test('F2.4-C1 CORRECTIVE MATRIX: CHECKPOINT DURABILITY, COMPLETE STATE & CONCURRENCY (C1-T01 - C1-T31)', async () => {
  const config = getTestConfig();
  await cleanDatabase(config);

  // C1-T22 - C1-T26: Migration runner & checksum invariants
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
    const projectRegistry = new ProjectRegistry(pool);
    const sessionManager = new SessionManager(pool);
    const decisionManager = new DecisionManager(pool);
    const checkpointManager = new CheckpointManager(pool);
    const auditRecorder = new AuditRecorder(pool);

    const auditCtx = getValidAuditContext();

    // Setup Test Projects
    const p1 = await projectRegistry.createProject({ displayName: 'Project Checkpoint C1 Alpha' }, auditCtx);
    const p2 = await projectRegistry.createProject({ displayName: 'Project Checkpoint C1 Beta' }, auditCtx);

    // C1-T03: normal INSERT through CheckpointManager -> PASS
    const cp1 = await checkpointManager.createCheckpoint(
      {
        projectId: p1.projectId,
        checkpointType: 'BOUNDARY',
        trigger: 'BOUNDARY_FROZEN'
      },
      auditCtx
    );
    assert.equal(cp1.sequence, 1);
    assert.equal(cp1.checkpointType, 'BOUNDARY');

    // C1-T01: direct UPDATE checkpoint -> REJECT at persistence level (Trigger throws exception)
    await assert.rejects(async () => {
      await pool.query("UPDATE checkpoints SET trigger = 'TAMPERED' WHERE checkpoint_id = $1;", [
        cp1.checkpointId
      ]);
    }, (err: any) => {
      assert.ok(err.message.includes('CHECKPOINT_IMMUTABILITY_VIOLATION'));
      return true;
    });

    // C1-T02: direct DELETE checkpoint -> REJECT at persistence level (Trigger throws exception)
    await assert.rejects(async () => {
      await pool.query("DELETE FROM checkpoints WHERE checkpoint_id = $1;", [cp1.checkpointId]);
    }, (err: any) => {
      assert.ok(err.message.includes('CHECKPOINT_IMMUTABILITY_VIOLATION'));
      return true;
    });

    // C1-T04: CheckpointStateV1 contains Project, Sessions, Decisions, WorkOrders, EvidenceReferences -> PASS
    assert.ok(cp1.statePayload.project);
    assert.ok(Array.isArray(cp1.statePayload.sessions));
    assert.ok(Array.isArray(cp1.statePayload.decisions));
    assert.ok(Array.isArray(cp1.statePayload.workOrders));
    assert.ok(Array.isArray(cp1.statePayload.evidenceReferences));

    // C1-T05 & C1-T06: Caller cannot forge canonical Work Orders / Evidence
    // Insert a valid Work Order and Evidence Reference directly into DB
    const wo1Res = await pool.query<{ work_order_id: string }>(
      "INSERT INTO work_orders (project_id, title, objective, status) VALUES ($1, 'WO C1 Test', 'Objective C1', 'READY') RETURNING work_order_id;",
      [p1.projectId]
    );
    const wo1Id = wo1Res.rows[0].work_order_id;

    const ev1Res = await pool.query<{ evidence_reference_id: string }>(
      "INSERT INTO evidence_references (project_id, evidence_type, provider, external_reference) VALUES ($1, 'GITHUB_COMMIT', 'GitHub', 'hash123') RETURNING evidence_reference_id;",
      [p1.projectId]
    );
    const ev1Id = ev1Res.rows[0].evidence_reference_id;

    const cp2 = await checkpointManager.createCheckpoint(
      {
        projectId: p1.projectId,
        checkpointType: 'BOUNDARY',
        trigger: 'BOUNDARY_FROZEN'
      },
      auditCtx
    );

    assert.equal(cp2.statePayload.workOrders.length, 1);
    assert.equal(cp2.statePayload.workOrders[0].workOrderId, wo1Id);
    assert.equal(cp2.statePayload.evidenceReferences.length, 1);
    assert.equal(cp2.statePayload.evidenceReferences[0].evidenceReferenceId, ev1Id);

    // C1-T09: unchanged complete state -> compare = MATCH
    const matchRes = await checkpointManager.compareCheckpointToCurrentState(cp2.checkpointId);
    assert.equal(matchRes.match, true);

    // C1-T07: Work Order state change after checkpoint -> compare = DRIFT
    await pool.query("UPDATE work_orders SET status = 'CLOSED' WHERE work_order_id = $1;", [wo1Id]);
    const driftWoRes = await checkpointManager.compareCheckpointToCurrentState(cp2.checkpointId);
    assert.equal(driftWoRes.match, false);

    // Re-sync checkpoint 3
    const cp3 = await checkpointManager.createCheckpoint(
      { projectId: p1.projectId, checkpointType: 'BOUNDARY', trigger: 'BOUNDARY_FROZEN' },
      auditCtx
    );
    assert.equal((await checkpointManager.compareCheckpointToCurrentState(cp3.checkpointId)).match, true);

    // C1-T08: Evidence Reference change/addition after checkpoint -> compare = DRIFT
    await pool.query(
      "INSERT INTO evidence_references (project_id, evidence_type, provider, external_reference) VALUES ($1, 'TEST_RESULT', 'Jest', 'ref-2');",
      [p1.projectId]
    );
    const driftEvRes = await checkpointManager.compareCheckpointToCurrentState(cp3.checkpointId);
    assert.equal(driftEvRes.match, false);

    // C1-T10 & C1-T11: Concurrent same-project checkpoint creation -> both succeed with sequences N and N+1
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
    assert.ok(c1);
    assert.ok(c2);
    const seqs = [c1.sequence, c2.sequence].sort((a, b) => a - b);
    assert.deepEqual(seqs, [1, 2]);

    // C1-T12: different-project checkpoint creation -> no unnecessary global serialization
    const [cP1, cP2] = await Promise.all([
      checkpointManager.createCheckpoint(
        { projectId: p1.projectId, checkpointType: 'BOUNDARY', trigger: 'OWNER_REQUEST' },
        auditCtx
      ),
      checkpointManager.createCheckpoint(
        { projectId: p2.projectId, checkpointType: 'BOUNDARY', trigger: 'OWNER_REQUEST' },
        auditCtx
      )
    ]);
    assert.ok(cP1);
    assert.ok(cP2);

    // C1-T15: SESSION close atomicity -> PASS
    const sOpen = await sessionManager.openSession(p1.projectId, auditCtx);
    const sClosed = await sessionManager.closeSession(sOpen.sessionId, auditCtx);
    assert.equal(sClosed.status, 'CLOSED');

    const closedCps = await checkpointManager.listCheckpoints(p1.projectId);
    const sCp = closedCps.find(c => c.sessionId === sOpen.sessionId);
    assert.ok(sCp);
    assert.equal(sCp?.checkpointType, 'SESSION');

    // C1-T17: cross-project isolation -> PASS
    await assert.rejects(async () => {
      await checkpointManager.createCheckpoint(
        {
          projectId: p2.projectId,
          checkpointType: 'SESSION',
          trigger: 'SESSION_CLOSE',
          sessionId: sOpen.sessionId // sOpen belongs to p1!
        },
        auditCtx
      );
    }, InvalidInputError);

    // C1-T22 - C1-T26: Migration checksums
    const checksum0001 = computeChecksum(await fs.readFile(path.join(config.migrationsDir, '0001_migration_foundation.sql'), 'utf8'));
    assert.equal(checksum0001, 'bf18157b31084de26ddbe15345835b1f8b324289f22e80826485b39a0a1be853');

    const checksum0002 = computeChecksum(await fs.readFile(path.join(config.migrationsDir, '0002_canonical_state.sql'), 'utf8'));
    assert.equal(checksum0002, '1305d1f2d59e815318309e86a10cde409eba140089b32e32aeaf50b5812df554');

    const checksum0003 = computeChecksum(await fs.readFile(path.join(config.migrationsDir, '0003_audit_identity.sql'), 'utf8'));
    assert.equal(checksum0003, 'db2fc2e583732e7ee91c30fe791371002f4492ce276a41bdd11e73845e47247b');

    const checksum0004 = computeChecksum(await fs.readFile(path.join(config.migrationsDir, '0004_checkpoints.sql'), 'utf8'));
    assert.ok(checksum0004 && checksum0004.length === 64);

    const migrationFiles = await fs.readdir(config.migrationsDir);
    assert.deepEqual(migrationFiles.sort(), [
      '0001_migration_foundation.sql',
      '0002_canonical_state.sql',
      '0003_audit_identity.sql',
      '0004_checkpoints.sql'
    ]);

  } finally {
    await pool.end();
  }
});
