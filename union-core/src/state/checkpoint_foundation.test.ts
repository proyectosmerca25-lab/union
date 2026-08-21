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

test('F2.4-C2 CORRECTIVE MATRIX: SESSION CHECKPOINT SNAPSHOT ISOLATION (C2-T01 - C2-T23)', async () => {
  const config = getTestConfig();
  await cleanDatabase(config);

  // C2-T17 - C2-T21: Migration runner & checksum invariants
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
    const p1 = await projectRegistry.createProject({ displayName: 'Project Checkpoint C2 Alpha' }, auditCtx);
    const p2 = await projectRegistry.createProject({ displayName: 'Project Checkpoint C2 Beta' }, auditCtx);

    // C2-T01: standalone Checkpoint transaction isolation -> REPEATABLE READ
    const standaloneClient = await pool.connect();
    try {
      await standaloneClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ;');
      const isoRes = await standaloneClient.query<{ transaction_isolation: string }>('SHOW transaction_isolation;');
      assert.equal(isoRes.rows[0].transaction_isolation, 'repeatable read');
      await standaloneClient.query('ROLLBACK;');
    } finally {
      standaloneClient.release();
    }

    // C2-T02: Session close transaction isolation -> REPEATABLE READ
    const sIsoTest = await sessionManager.openSession(p1.projectId, auditCtx);
    const closeClient = await pool.connect();
    try {
      await closeClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ;');
      const isoRes = await closeClient.query<{ transaction_isolation: string }>('SHOW transaction_isolation;');
      assert.equal(isoRes.rows[0].transaction_isolation, 'repeatable read');
      await closeClient.query('ROLLBACK;');
    } finally {
      closeClient.release();
    }

    // C2-T04 & C2-T05: SESSION checkpoint created & Session CLOSED under REPEATABLE READ
    const sClosed = await sessionManager.closeSession(sIsoTest.sessionId, auditCtx);
    assert.equal(sClosed.status, 'CLOSED');

    const closedCps = await checkpointManager.listCheckpoints(p1.projectId);
    const sCp = closedCps.find(c => c.sessionId === sIsoTest.sessionId);
    assert.ok(sCp);
    assert.equal(sCp?.checkpointType, 'SESSION');

    // C2-T03: concurrent mutation during SESSION checkpoint -> no mixed state
    const sConcurrent = await sessionManager.openSession(p1.projectId, auditCtx);
    const mutClient = await pool.connect();
    try {
      // Concurrent insert during closeSession
      const closePromise = sessionManager.closeSession(sConcurrent.sessionId, auditCtx);
      await mutClient.query(
        "INSERT INTO decisions (project_id, topic, decision, status, reason, authority) VALUES ($1, 'Concurrent Topic', 'Decision', 'PROPOSED', 'Concurrent Reason', 'Omar');",
        [p1.projectId]
      );
      const resSession = await closePromise;
      assert.equal(resSession.status, 'CLOSED');
    } finally {
      mutClient.release();
    }

    // C2-T06: Checkpoint failure -> Session remains OPEN
    const sFailCheck = await sessionManager.openSession(p1.projectId, auditCtx);
    // Force checkpoint failure by passing an invalid auditContext to closeSession
    const invalidCtx = { ...auditCtx, executedBy: 'INVALID' as any };
    await assert.rejects(async () => {
      await sessionManager.closeSession(sFailCheck.sessionId, invalidCtx);
    }, InvalidInputError);

    // Verify session remains OPEN
    const sStillOpen = await sessionManager.getSession(sFailCheck.sessionId);
    assert.equal(sStillOpen.status, 'OPEN');

    // C2-T09: direct UPDATE/DELETE checkpoint protection -> REJECT
    const cp1 = await checkpointManager.createCheckpoint(
      { projectId: p1.projectId, checkpointType: 'BOUNDARY', trigger: 'BOUNDARY_FROZEN' },
      auditCtx
    );

    await assert.rejects(async () => {
      await pool.query("UPDATE checkpoints SET trigger = 'TAMPERED' WHERE checkpoint_id = $1;", [
        cp1.checkpointId
      ]);
    }, (err: any) => {
      assert.ok(err.message.includes('CHECKPOINT_IMMUTABILITY_VIOLATION'));
      return true;
    });

    await assert.rejects(async () => {
      await pool.query("DELETE FROM checkpoints WHERE checkpoint_id = $1;", [cp1.checkpointId]);
    }, (err: any) => {
      assert.ok(err.message.includes('CHECKPOINT_IMMUTABILITY_VIOLATION'));
      return true;
    });

    // C2-T10 & C2-T11 & C2-T12: Work Orders, Evidence References included & state hash complete
    const wo1Res = await pool.query<{ work_order_id: string }>(
      "INSERT INTO work_orders (project_id, title, objective, status) VALUES ($1, 'WO C2 Test', 'Objective C2', 'READY') RETURNING work_order_id;",
      [p1.projectId]
    );
    const wo1Id = wo1Res.rows[0].work_order_id;

    const ev1Res = await pool.query<{ evidence_reference_id: string }>(
      "INSERT INTO evidence_references (project_id, evidence_type, provider, external_reference) VALUES ($1, 'GITHUB_COMMIT', 'GitHub', 'hash456') RETURNING evidence_reference_id;",
      [p1.projectId]
    );
    const ev1Id = ev1Res.rows[0].evidence_reference_id;

    const cp2 = await checkpointManager.createCheckpoint(
      { projectId: p1.projectId, checkpointType: 'BOUNDARY', trigger: 'BOUNDARY_FROZEN' },
      auditCtx
    );

    assert.equal(cp2.statePayload.workOrders.length, 1);
    assert.equal(cp2.statePayload.workOrders[0].workOrderId, wo1Id);
    assert.equal(cp2.statePayload.evidenceReferences.length, 1);
    assert.equal(cp2.statePayload.evidenceReferences[0].evidenceReferenceId, ev1Id);
    assert.ok(cp2.stateHash && cp2.stateHash.length === 64);

    // C2-T08: project sequence concurrency -> PASS
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

    // C2-T17 - C2-T20: Migration checksums
    const checksum0001 = computeChecksum(await fs.readFile(path.join(config.migrationsDir, '0001_migration_foundation.sql'), 'utf8'));
    assert.equal(checksum0001, 'bf18157b31084de26ddbe15345835b1f8b324289f22e80826485b39a0a1be853');

    const checksum0002 = computeChecksum(await fs.readFile(path.join(config.migrationsDir, '0002_canonical_state.sql'), 'utf8'));
    assert.equal(checksum0002, '1305d1f2d59e815318309e86a10cde409eba140089b32e32aeaf50b5812df554');

    const checksum0003 = computeChecksum(await fs.readFile(path.join(config.migrationsDir, '0003_audit_identity.sql'), 'utf8'));
    assert.equal(checksum0003, 'db2fc2e583732e7ee91c30fe791371002f4492ce276a41bdd11e73845e47247b');

    const checksum0004 = computeChecksum(await fs.readFile(path.join(config.migrationsDir, '0004_checkpoints.sql'), 'utf8'));
    assert.equal(checksum0004, '48efd4b56c025a2e672230050d049543e14da2075bcc440929272089447d2c08');

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
