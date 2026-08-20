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
  InvalidInputError,
  NotFoundError
} from './errors.js';
import {
  AuditAction,
  AuditActor,
  AuditAuthorityBasis,
  AuditAuthorityHolder,
  AuditContext,
  AuditResult
} from './types.js';

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

test('F2.3-C1 CORRECTIVE TEST MATRIX: FAIL-CLOSED AUTHORITY PROVENANCE (C1-T01 - C1-T38)', async () => {
  const config = getTestConfig();
  await cleanDatabase(config);

  const migrationRes = await runMigrations(config);
  assert.equal(migrationRes.appliedCount, 4);

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

    const trace1 = '44444444-4444-4444-4444-444444444444';
    const baseAuditCtx: AuditContext = {
      traceId: trace1,
      actor: 'OWNER',
      authorityHolder: 'OWNER',
      authorityBasis: 'OWNER_EXPLICIT',
      coordinatedBy: 'UNION',
      executedBy: 'UNION_CORE'
    };

    const p1 = await projectRegistry.createProject({ displayName: 'Fail Closed Audit Test' }, baseAuditCtx);

    // C1-T01: authority_holder = OWNER -> PASS
    const ae01 = await auditRecorder.recordAuditEvent({
      traceId: trace1,
      projectId: p1.projectId,
      actor: 'OWNER',
      action: 'PROJECT_CREATED',
      authorityHolder: 'OWNER',
      authorityBasis: 'OWNER_EXPLICIT',
      coordinatedBy: 'UNION',
      executedBy: 'UNION_CORE',
      result: 'SUCCESS'
    });
    assert.equal(ae01.authorityHolder, 'OWNER');

    // C1-T02: authority_holder = UNION -> PASS
    const ae02 = await auditRecorder.recordAuditEvent({
      traceId: trace1,
      projectId: p1.projectId,
      actor: 'UNION',
      action: 'PROJECT_CREATED',
      authorityHolder: 'UNION',
      authorityBasis: 'THIN_AUTHORITY',
      coordinatedBy: 'UNION',
      executedBy: 'UNION_CORE',
      result: 'SUCCESS'
    });
    assert.equal(ae02.authorityHolder, 'UNION');

    // C1-T03: authority_holder = ANTIGRAVITY -> REJECT
    await assert.rejects(async () => {
      await auditRecorder.recordAuditEvent({
        traceId: trace1,
        projectId: p1.projectId,
        actor: 'OWNER',
        action: 'PROJECT_CREATED',
        authorityHolder: 'ANTIGRAVITY' as any,
        authorityBasis: 'OWNER_EXPLICIT',
        coordinatedBy: 'UNION',
        executedBy: 'UNION_CORE',
        result: 'SUCCESS'
      });
    }, InvalidInputError);

    // C1-T04: authority_holder = GITHUB -> REJECT
    await assert.rejects(async () => {
      await auditRecorder.recordAuditEvent({
        traceId: trace1,
        projectId: p1.projectId,
        actor: 'OWNER',
        action: 'PROJECT_CREATED',
        authorityHolder: 'GITHUB' as any,
        authorityBasis: 'OWNER_EXPLICIT',
        coordinatedBy: 'UNION',
        executedBy: 'UNION_CORE',
        result: 'SUCCESS'
      });
    }, InvalidInputError);

    // C1-T05: authority_holder = unknown future capability -> REJECT
    await assert.rejects(async () => {
      await auditRecorder.recordAuditEvent({
        traceId: trace1,
        projectId: p1.projectId,
        actor: 'OWNER',
        action: 'PROJECT_CREATED',
        authorityHolder: 'FUTURE_AI_AGENT_X' as any,
        authorityBasis: 'OWNER_EXPLICIT',
        coordinatedBy: 'UNION',
        executedBy: 'UNION_CORE',
        result: 'SUCCESS'
      });
    }, InvalidInputError);

    // C1-T06: authority_holder = UNION_CORE -> REJECT
    await assert.rejects(async () => {
      await auditRecorder.recordAuditEvent({
        traceId: trace1,
        projectId: p1.projectId,
        actor: 'OWNER',
        action: 'PROJECT_CREATED',
        authorityHolder: 'UNION_CORE' as any,
        authorityBasis: 'OWNER_EXPLICIT',
        coordinatedBy: 'UNION',
        executedBy: 'UNION_CORE',
        result: 'SUCCESS'
      });
    }, InvalidInputError);

    // C1-T07: actor = OWNER / UNION / SYSTEM -> PASS
    for (const actorVal of ['OWNER', 'UNION', 'SYSTEM'] as AuditActor[]) {
      const aeActor = await auditRecorder.recordAuditEvent({
        traceId: trace1,
        projectId: p1.projectId,
        actor: actorVal,
        action: 'PROJECT_CREATED',
        authorityHolder: 'OWNER',
        authorityBasis: 'OWNER_EXPLICIT',
        coordinatedBy: 'UNION',
        executedBy: 'UNION_CORE',
        result: 'SUCCESS'
      });
      assert.equal(aeActor.actor, actorVal);
    }

    // C1-T08: unknown actor -> REJECT
    await assert.rejects(async () => {
      await auditRecorder.recordAuditEvent({
        traceId: trace1,
        projectId: p1.projectId,
        actor: 'UNKNOWN_USER' as any,
        action: 'PROJECT_CREATED',
        authorityHolder: 'OWNER',
        authorityBasis: 'OWNER_EXPLICIT',
        coordinatedBy: 'UNION',
        executedBy: 'UNION_CORE',
        result: 'SUCCESS'
      });
    }, InvalidInputError);

    // C1-T09: each approved authority_basis -> PASS
    const approvedBases: AuditAuthorityBasis[] = [
      'OWNER_EXPLICIT',
      'OWNER_DELEGATED_ENVELOPE',
      'FROZEN_DECISION',
      'GOVERNANCE_RULE',
      'THIN_AUTHORITY',
      'SYSTEM_SAFETY_RULE'
    ];
    for (const basisVal of approvedBases) {
      const aeBasis = await auditRecorder.recordAuditEvent({
        traceId: trace1,
        projectId: p1.projectId,
        actor: 'OWNER',
        action: 'PROJECT_CREATED',
        authorityHolder: 'OWNER',
        authorityBasis: basisVal,
        coordinatedBy: 'UNION',
        executedBy: 'UNION_CORE',
        result: 'SUCCESS'
      });
      assert.equal(aeBasis.authorityBasis, basisVal);
    }

    // C1-T10: unknown authority_basis -> REJECT
    await assert.rejects(async () => {
      await auditRecorder.recordAuditEvent({
        traceId: trace1,
        projectId: p1.projectId,
        actor: 'OWNER',
        action: 'PROJECT_CREATED',
        authorityHolder: 'OWNER',
        authorityBasis: 'IMPLICIT_TRUST' as any,
        coordinatedBy: 'UNION',
        executedBy: 'UNION_CORE',
        result: 'SUCCESS'
      });
    }, InvalidInputError);

    // C1-T11: coordinated_by = UNION -> PASS
    const aeCoord = await auditRecorder.recordAuditEvent({
      traceId: trace1,
      projectId: p1.projectId,
      actor: 'OWNER',
      action: 'PROJECT_CREATED',
      authorityHolder: 'OWNER',
      authorityBasis: 'OWNER_EXPLICIT',
      coordinatedBy: 'UNION',
      executedBy: 'UNION_CORE',
      result: 'SUCCESS'
    });
    assert.equal(aeCoord.coordinatedBy, 'UNION');

    // C1-T12, C1-T13, C1-T14: coordinated_by != UNION -> REJECT
    for (const invalidCoord of ['ANTIGRAVITY', 'GITHUB', 'UNION_CORE']) {
      await assert.rejects(async () => {
        await auditRecorder.recordAuditEvent({
          traceId: trace1,
          projectId: p1.projectId,
          actor: 'OWNER',
          action: 'PROJECT_CREATED',
          authorityHolder: 'OWNER',
          authorityBasis: 'OWNER_EXPLICIT',
          coordinatedBy: invalidCoord as any,
          executedBy: 'UNION_CORE',
          result: 'SUCCESS'
        });
      }, InvalidInputError);
    }

    // C1-T15: canonical manager write with executed_by = UNION_CORE -> PASS
    const pMgrPass = await projectRegistry.createProject({ displayName: 'Manager Pass Project' }, baseAuditCtx);
    assert.ok(pMgrPass.projectId);

    // C1-T16: canonical manager write with unauthorized executed_by -> REJECT
    await assert.rejects(async () => {
      await projectRegistry.createProject(
        { displayName: 'Manager Fail Project' },
        { ...baseAuditCtx, executedBy: 'ANTIGRAVITY' as any }
      );
    }, InvalidInputError);

    // C1-T17: all approved F2.3 action values -> PASS
    const approvedActions: AuditAction[] = [
      'PROJECT_CREATED',
      'PROJECT_RENAMED',
      'PROJECT_STATUS_CHANGED',
      'SESSION_OPENED',
      'SESSION_CLOSED',
      'DECISION_CREATED',
      'DECISION_CONTENT_UPDATED',
      'DECISION_APPROVED',
      'DECISION_FROZEN',
      'DECISION_REOPENED',
      'DECISION_REJECTED',
      'DECISION_SUPERSEDED'
    ];
    for (const actVal of approvedActions) {
      const aeAction = await auditRecorder.recordAuditEvent({
        traceId: trace1,
        projectId: p1.projectId,
        actor: 'OWNER',
        action: actVal,
        authorityHolder: 'OWNER',
        authorityBasis: 'OWNER_EXPLICIT',
        coordinatedBy: 'UNION',
        executedBy: 'UNION_CORE',
        result: 'SUCCESS'
      });
      assert.equal(aeAction.action, actVal);
    }

    // C1-T18: unknown action -> REJECT
    await assert.rejects(async () => {
      await auditRecorder.recordAuditEvent({
        traceId: trace1,
        projectId: p1.projectId,
        actor: 'OWNER',
        action: 'UNKNOWN_CUSTOM_ACTION' as any,
        authorityHolder: 'OWNER',
        authorityBasis: 'OWNER_EXPLICIT',
        coordinatedBy: 'UNION',
        executedBy: 'UNION_CORE',
        result: 'SUCCESS'
      });
    }, InvalidInputError);

    // C1-T19: SUCCESS / DENIED / FAILED -> PASS
    for (const resVal of ['SUCCESS', 'DENIED', 'FAILED'] as AuditResult[]) {
      const aeResult = await auditRecorder.recordAuditEvent({
        traceId: trace1,
        projectId: p1.projectId,
        actor: 'OWNER',
        action: 'PROJECT_CREATED',
        authorityHolder: 'OWNER',
        authorityBasis: 'OWNER_EXPLICIT',
        coordinatedBy: 'UNION',
        executedBy: 'UNION_CORE',
        result: resVal
      });
      assert.equal(aeResult.result, resVal);
    }

    // C1-T20: unknown result -> REJECT
    await assert.rejects(async () => {
      await auditRecorder.recordAuditEvent({
        traceId: trace1,
        projectId: p1.projectId,
        actor: 'OWNER',
        action: 'PROJECT_CREATED',
        authorityHolder: 'OWNER',
        authorityBasis: 'OWNER_EXPLICIT',
        coordinatedBy: 'UNION',
        executedBy: 'UNION_CORE',
        result: 'MAYBE' as any
      });
    }, InvalidInputError);

    // C1-T21: no authority fallback (missing/empty authority_holder -> REJECT) -> PASS
    await assert.rejects(async () => {
      await auditRecorder.recordAuditEvent({
        traceId: trace1,
        projectId: p1.projectId,
        actor: 'OWNER',
        action: 'PROJECT_CREATED',
        authorityHolder: '' as any,
        authorityBasis: 'OWNER_EXPLICIT',
        coordinatedBy: 'UNION',
        executedBy: 'UNION_CORE',
        result: 'SUCCESS'
      });
    }, InvalidInputError);

    // C1-T22: execution identity does not infer authority -> REJECT when executed_by used as authority_holder
    await assert.rejects(async () => {
      await auditRecorder.recordAuditEvent({
        traceId: trace1,
        projectId: p1.projectId,
        actor: 'OWNER',
        action: 'PROJECT_CREATED',
        authorityHolder: 'UNION_CORE' as any, // Cannot assign executor identity as authority holder!
        authorityBasis: 'OWNER_EXPLICIT',
        coordinatedBy: 'UNION',
        executedBy: 'UNION_CORE',
        result: 'SUCCESS'
      });
    }, InvalidInputError);

    // C1-T23: actor does not infer authority -> REJECT when non-authority actor used as authority_holder
    await assert.rejects(async () => {
      await auditRecorder.recordAuditEvent({
        traceId: trace1,
        projectId: p1.projectId,
        actor: 'SYSTEM',
        action: 'PROJECT_CREATED',
        authorityHolder: 'SYSTEM' as any, // SYSTEM is valid actor, but NOT an authority holder!
        authorityBasis: 'SYSTEM_SAFETY_RULE',
        coordinatedBy: 'UNION',
        executedBy: 'UNION_CORE',
        result: 'SUCCESS'
      });
    }, InvalidInputError);

    // C1-T24: Thin Authority canonical case -> PASS
    const aeThin = await auditRecorder.recordAuditEvent({
      traceId: trace1,
      projectId: p1.projectId,
      actor: 'UNION',
      action: 'PROJECT_CREATED',
      authorityHolder: 'UNION',
      authorityBasis: 'THIN_AUTHORITY',
      coordinatedBy: 'UNION',
      executedBy: 'UNION_CORE',
      result: 'SUCCESS'
    });
    assert.equal(aeThin.actor, 'UNION');
    assert.equal(aeThin.authorityHolder, 'UNION');
    assert.equal(aeThin.authorityBasis, 'THIN_AUTHORITY');

    // C1-T25: state + audit transactional rollback regression -> PASS
    await assert.rejects(async () => {
      await projectRegistry.createProject(
        { displayName: 'Rollback Failure Test' },
        { ...baseAuditCtx, authorityHolder: 'INVALID_HOLDER' as any }
      );
    }, InvalidInputError);
    const projectsList = await projectRegistry.listProjects();
    assert.equal(projectsList.find(p => p.displayName === 'Rollback Failure Test'), undefined);

    // C1-T26: cross-project audit isolation -> PASS
    const p2 = await projectRegistry.createProject({ displayName: 'Project Beta' }, baseAuditCtx);
    const s1 = await sessionManager.openSession(p1.projectId, baseAuditCtx);
    await assert.rejects(async () => {
      await auditRecorder.recordAuditEvent({
        traceId: trace1,
        projectId: p2.projectId,
        sessionId: s1.sessionId,
        actor: 'OWNER',
        action: 'SESSION_CLOSED',
        authorityHolder: 'OWNER',
        authorityBasis: 'OWNER_EXPLICIT',
        coordinatedBy: 'UNION',
        executedBy: 'UNION_CORE',
        result: 'SUCCESS'
      });
    }, NotFoundError);

    // C1-T27: append-only audit -> PASS
    assert.equal((auditRecorder as any).updateAuditEvent, undefined);
    assert.equal((auditRecorder as any).deleteAuditEvent, undefined);

    // C1-T31 - C1-T34: Checksum and Migration File Invariants
    const checksum0001 = computeChecksum(await fs.readFile(path.join(config.migrationsDir, '0001_migration_foundation.sql'), 'utf8'));
    assert.equal(checksum0001, 'bf18157b31084de26ddbe15345835b1f8b324289f22e80826485b39a0a1be853');

    const checksum0002 = computeChecksum(await fs.readFile(path.join(config.migrationsDir, '0002_canonical_state.sql'), 'utf8'));
    assert.equal(checksum0002, '1305d1f2d59e815318309e86a10cde409eba140089b32e32aeaf50b5812df554');

    const checksum0003 = computeChecksum(await fs.readFile(path.join(config.migrationsDir, '0003_audit_identity.sql'), 'utf8'));
    assert.equal(checksum0003, 'db2fc2e583732e7ee91c30fe791371002f4492ce276a41bdd11e73845e47247b');

    const migrationFiles = await fs.readdir(config.migrationsDir);
    assert.deepEqual(migrationFiles.sort(), [
      '0001_migration_foundation.sql',
      '0002_canonical_state.sql',
      '0003_audit_identity.sql',
      '0004_checkpoints.sql'
    ]);
  } finally {
    await client.end();
  }
});
