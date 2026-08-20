import crypto from 'node:crypto';
import pg from 'pg';
import { AuditRecorder } from './audit-recorder.js';
import {
  DatabaseFailureError,
  InvalidInputError,
  NotFoundError
} from './errors.js';
import {
  AuditContext,
  Checkpoint,
  CheckpointStateV1,
  CheckpointType,
  CheckpointTrigger,
  CreateCheckpointInput,
  Decision,
  Project,
  Session
} from './types.js';

export function canonicalizeValue(val: unknown): unknown {
  if (val === null || val === undefined) return null;
  if (typeof val !== 'object') return val;
  if (val instanceof Date) return val.toISOString();
  if (Array.isArray(val)) {
    return val.map(canonicalizeValue);
  }
  const obj = val as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const result: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    result[k] = canonicalizeValue(obj[k]);
  }
  return result;
}

export function computeStateHash(payload: CheckpointStateV1): string {
  const canonicalObj = canonicalizeValue(payload);
  const jsonStr = JSON.stringify(canonicalObj);
  return crypto.createHash('sha256').update(jsonStr, 'utf8').digest('hex');
}

function validateManagerAuditContext(ctx: AuditContext): void {
  if (!ctx) {
    throw new InvalidInputError('AuditContext is required for state manager write operations');
  }
  if (ctx.executedBy !== 'UNION_CORE') {
    throw new InvalidInputError(
      `Canonical state manager operations strictly require executedBy === 'UNION_CORE' (received '${ctx.executedBy}')`
    );
  }
}

function mapRowToCheckpoint(row: any): Checkpoint {
  let statePayloadData: CheckpointStateV1;
  if (typeof row.state_payload === 'string') {
    statePayloadData = JSON.parse(row.state_payload);
  } else {
    statePayloadData = row.state_payload;
  }

  return {
    checkpointId: row.checkpoint_id,
    projectId: row.project_id,
    checkpointType: row.checkpoint_type as CheckpointType,
    sequence: Number(row.sequence),
    stateSchemaVersion: Number(row.state_schema_version),
    statePayload: statePayloadData,
    stateHash: row.state_hash,
    sessionId: row.session_id || null,
    trigger: row.trigger as CheckpointTrigger,
    operationTraceId: row.operation_trace_id || null,
    actor: row.actor,
    authorityHolder: row.authority_holder,
    authorityBasis: row.authority_basis,
    authorityReference: row.authority_reference || null,
    coordinatedBy: row.coordinated_by,
    executedBy: row.executed_by,
    traceId: row.trace_id,
    createdAt: new Date(row.created_at)
  };
}

export class CheckpointManager {
  private readonly auditRecorder: AuditRecorder;

  constructor(private readonly client: pg.Client | pg.Pool) {
    this.auditRecorder = new AuditRecorder(client);
  }

  async createCheckpoint(
    input: CreateCheckpointInput,
    auditContext: AuditContext,
    clientOverride?: pg.ClientBase
  ): Promise<Checkpoint> {
    validateManagerAuditContext(auditContext);

    if (!input) throw new InvalidInputError('CreateCheckpointInput is required');
    if (!input.projectId || typeof input.projectId !== 'string' || input.projectId.trim() === '') {
      throw new InvalidInputError('projectId is required');
    }
    if (!input.checkpointType || typeof input.checkpointType !== 'string') {
      throw new InvalidInputError('checkpointType is required');
    }
    if (!input.trigger || typeof input.trigger !== 'string') {
      throw new InvalidInputError('trigger is required');
    }

    const validTypes: Set<string> = new Set(['BOUNDARY', 'PROTECTIVE_PRE', 'PROTECTIVE_POST', 'SESSION']);
    if (!validTypes.has(input.checkpointType)) {
      throw new InvalidInputError(`Unsupported checkpoint_type: '${input.checkpointType}'`);
    }

    const validTriggers: Set<string> = new Set([
      'BOUNDARY_FROZEN',
      'PRE_RISK_OPERATION',
      'POST_RISK_OPERATION',
      'SESSION_CLOSE',
      'PROJECT_PAUSE',
      'PROJECT_COMPLETION',
      'OWNER_REQUEST'
    ]);
    if (!validTriggers.has(input.trigger)) {
      throw new InvalidInputError(`Unsupported trigger: '${input.trigger}'`);
    }

    // Type-specific required field validations
    if (input.checkpointType === 'SESSION' && (!input.sessionId || input.sessionId.trim() === '')) {
      throw new InvalidInputError('SESSION checkpoint requires session_id');
    }

    if (
      (input.checkpointType === 'PROTECTIVE_PRE' || input.checkpointType === 'PROTECTIVE_POST') &&
      (!input.operationTraceId || input.operationTraceId.trim() === '')
    ) {
      throw new InvalidInputError(`${input.checkpointType} checkpoint requires operation_trace_id`);
    }

    const projectId = input.projectId.trim();

    // Use transaction if clientOverride is provided, else manage transaction internally
    const useExternalTx = Boolean(clientOverride);
    const txClient = clientOverride || (await (this.client as pg.Pool).connect());

    try {
      if (!useExternalTx) {
        await txClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ;');
      }

      // 1. Verify Project exists
      const projRes = await txClient.query('SELECT * FROM projects WHERE project_id = $1;', [projectId]);
      if (projRes.rows.length === 0) {
        throw new NotFoundError(`Project not found: '${projectId}'`);
      }
      const projectRow = projRes.rows[0];
      const project: Project = {
        projectId: projectRow.project_id,
        displayName: projectRow.display_name,
        status: projectRow.status,
        createdAt: new Date(projectRow.created_at),
        updatedAt: new Date(projectRow.updated_at)
      };

      // 2. Validate session if provided
      if (input.sessionId) {
        const sessRes = await txClient.query(
          'SELECT * FROM sessions WHERE session_id = $1 AND project_id = $2;',
          [input.sessionId.trim(), projectId]
        );
        if (sessRes.rows.length === 0) {
          throw new InvalidInputError(
            `Session '${input.sessionId}' does not belong to project '${projectId}' (cross-project reference rejected)`
          );
        }
      }

      // 3. Query all Sessions belonging to Project
      const sessionsRes = await txClient.query(
        'SELECT * FROM sessions WHERE project_id = $1 ORDER BY session_id ASC;',
        [projectId]
      );
      const sessions: Session[] = sessionsRes.rows.map(r => ({
        sessionId: r.session_id,
        projectId: r.project_id,
        status: r.status,
        startedAt: new Date(r.started_at),
        closedAt: r.closed_at ? new Date(r.closed_at) : null,
        createdAt: new Date(r.created_at),
        updatedAt: new Date(r.updated_at)
      }));

      // 4. Query all Decisions belonging to Project
      const decisionsRes = await txClient.query(
        'SELECT * FROM decisions WHERE project_id = $1 ORDER BY decision_id ASC;',
        [projectId]
      );
      const decisions: Decision[] = decisionsRes.rows.map(r => ({
        decisionId: r.decision_id,
        projectId: r.project_id,
        sessionId: r.session_id || null,
        topic: r.topic,
        decision: r.decision,
        status: r.status,
        reason: r.reason || null,
        alternativesConsidered: r.alternatives_considered ? JSON.parse(r.alternatives_considered) : null,
        authority: r.authority,
        supersedesDecisionId: r.supersedes_decision_id || null,
        reopenCondition: r.reopen_condition || null,
        createdAt: new Date(r.created_at),
        updatedAt: new Date(r.updated_at),
        decidedAt: r.decided_at ? new Date(r.decided_at) : null
      }));

      // 5. Concurrency-safe Sequence Allocation
      const seqRes = await txClient.query(
        'SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq FROM checkpoints WHERE project_id = $1;',
        [projectId]
      );
      const sequence = Number(seqRes.rows[0].next_seq);

      // 6. Build CheckpointStateV1
      const statePayload: CheckpointStateV1 = {
        version: 1,
        projectId,
        project,
        sessions,
        decisions,
        activePhase: input.activePhase ?? null,
        activeBlock: input.activeBlock ?? null,
        lastCompletedBoundary: input.lastCompletedBoundary ?? null,
        openItems: input.openItems ? [...input.openItems].sort() : [],
        deferredItems: input.deferredItems ? [...input.deferredItems].sort() : [],
        blockers: input.blockers ? [...input.blockers].sort() : [],
        repositoryState: input.repositoryState ?? null,
        productionState: input.productionState ?? null,
        lastConfirmedAction: input.lastConfirmedAction ?? null,
        pendingWork: input.pendingWork ? [...input.pendingWork] : [],
        nextRecommendedAction: input.nextRecommendedAction ?? null
      };

      // 7. Compute state hash
      const stateHash = computeStateHash(statePayload);

      // 8. Insert checkpoint row
      const insRes = await txClient.query(
        `INSERT INTO checkpoints (
           project_id, checkpoint_type, sequence, state_schema_version,
           state_payload, state_hash, session_id, trigger, operation_trace_id,
           actor, authority_holder, authority_basis, authority_reference,
           coordinated_by, executed_by, trace_id
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         RETURNING *;`,
        [
          projectId,
          input.checkpointType,
          sequence,
          1,
          JSON.stringify(statePayload),
          stateHash,
          input.sessionId ? input.sessionId.trim() : null,
          input.trigger,
          input.operationTraceId ? input.operationTraceId.trim() : null,
          auditContext.actor,
          auditContext.authorityHolder,
          auditContext.authorityBasis,
          auditContext.authorityReference || null,
          auditContext.coordinatedBy,
          auditContext.executedBy,
          auditContext.traceId
        ]
      );

      // 9. Transactional Audit Event
      await this.auditRecorder.recordAuditEvent(
        {
          ...auditContext,
          projectId,
          sessionId: input.sessionId || null,
          action: 'CHECKPOINT_CREATED',
          result: 'SUCCESS'
        },
        txClient
      );

      if (!useExternalTx) {
        await txClient.query('COMMIT;');
      }

      return mapRowToCheckpoint(insRes.rows[0]);
    } catch (err: unknown) {
      if (!useExternalTx) {
        await txClient.query('ROLLBACK;').catch(() => {});
      }
      if (err instanceof InvalidInputError || err instanceof NotFoundError) throw err;
      throw new DatabaseFailureError('Failed to create checkpoint');
    } finally {
      if (!useExternalTx) {
        (txClient as pg.PoolClient).release();
      }
    }
  }

  async getCheckpoint(checkpointId: string): Promise<Checkpoint> {
    if (!checkpointId || checkpointId.trim() === '') {
      throw new InvalidInputError('checkpointId is required');
    }
    try {
      const res = await this.client.query('SELECT * FROM checkpoints WHERE checkpoint_id = $1;', [
        checkpointId.trim()
      ]);
      if (res.rows.length === 0) {
        throw new NotFoundError(`Checkpoint not found with checkpoint_id: '${checkpointId}'`);
      }
      return mapRowToCheckpoint(res.rows[0]);
    } catch (err: unknown) {
      if (err instanceof NotFoundError || err instanceof InvalidInputError) throw err;
      throw new DatabaseFailureError('Failed to fetch checkpoint');
    }
  }

  async getLatestCheckpoint(projectId: string): Promise<Checkpoint> {
    if (!projectId || projectId.trim() === '') {
      throw new InvalidInputError('projectId is required');
    }
    try {
      const res = await this.client.query(
        'SELECT * FROM checkpoints WHERE project_id = $1 ORDER BY sequence DESC LIMIT 1;',
        [projectId.trim()]
      );
      if (res.rows.length === 0) {
        throw new NotFoundError(`No checkpoints found for project_id: '${projectId}'`);
      }
      return mapRowToCheckpoint(res.rows[0]);
    } catch (err: unknown) {
      if (err instanceof NotFoundError || err instanceof InvalidInputError) throw err;
      throw new DatabaseFailureError('Failed to fetch latest checkpoint');
    }
  }

  async listCheckpoints(projectId: string): Promise<Checkpoint[]> {
    if (!projectId || projectId.trim() === '') {
      throw new InvalidInputError('projectId is required');
    }
    try {
      const res = await this.client.query(
        'SELECT * FROM checkpoints WHERE project_id = $1 ORDER BY sequence ASC;',
        [projectId.trim()]
      );
      return res.rows.map(mapRowToCheckpoint);
    } catch (err: unknown) {
      if (err instanceof InvalidInputError) throw err;
      throw new DatabaseFailureError('Failed to list checkpoints');
    }
  }

  async compareCheckpointToCurrentState(
    checkpointId: string
  ): Promise<{ match: boolean; checkpointHash: string; currentHash: string }> {
    const cp = await this.getCheckpoint(checkpointId);
    const projectId = cp.projectId;

    // Fetch current project state
    const projRes = await this.client.query('SELECT * FROM projects WHERE project_id = $1;', [projectId]);
    if (projRes.rows.length === 0) {
      throw new NotFoundError(`Project not found: '${projectId}'`);
    }
    const projectRow = projRes.rows[0];
    const project: Project = {
      projectId: projectRow.project_id,
      displayName: projectRow.display_name,
      status: projectRow.status,
      createdAt: new Date(projectRow.created_at),
      updatedAt: new Date(projectRow.updated_at)
    };

    const sessionsRes = await this.client.query(
      'SELECT * FROM sessions WHERE project_id = $1 ORDER BY session_id ASC;',
      [projectId]
    );
    const sessions: Session[] = sessionsRes.rows.map(r => ({
      sessionId: r.session_id,
      projectId: r.project_id,
      status: r.status,
      startedAt: new Date(r.started_at),
      closedAt: r.closed_at ? new Date(r.closed_at) : null,
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at)
    }));

    const decisionsRes = await this.client.query(
      'SELECT * FROM decisions WHERE project_id = $1 ORDER BY decision_id ASC;',
      [projectId]
    );
    const decisions: Decision[] = decisionsRes.rows.map(r => ({
      decisionId: r.decision_id,
      projectId: r.project_id,
      sessionId: r.session_id || null,
      topic: r.topic,
      decision: r.decision,
      status: r.status,
      reason: r.reason || null,
      alternativesConsidered: r.alternatives_considered ? JSON.parse(r.alternatives_considered) : null,
      authority: r.authority,
      supersedesDecisionId: r.supersedes_decision_id || null,
      reopenCondition: r.reopen_condition || null,
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
      decidedAt: r.decided_at ? new Date(r.decided_at) : null
    }));

    const currentStatePayload: CheckpointStateV1 = {
      version: 1,
      projectId,
      project,
      sessions,
      decisions,
      activePhase: cp.statePayload.activePhase ?? null,
      activeBlock: cp.statePayload.activeBlock ?? null,
      lastCompletedBoundary: cp.statePayload.lastCompletedBoundary ?? null,
      openItems: cp.statePayload.openItems ? [...cp.statePayload.openItems].sort() : [],
      deferredItems: cp.statePayload.deferredItems ? [...cp.statePayload.deferredItems].sort() : [],
      blockers: cp.statePayload.blockers ? [...cp.statePayload.blockers].sort() : [],
      repositoryState: cp.statePayload.repositoryState ?? null,
      productionState: cp.statePayload.productionState ?? null,
      lastConfirmedAction: cp.statePayload.lastConfirmedAction ?? null,
      pendingWork: cp.statePayload.pendingWork ? [...cp.statePayload.pendingWork] : [],
      nextRecommendedAction: cp.statePayload.nextRecommendedAction ?? null
    };

    const currentHash = computeStateHash(currentStatePayload);
    return {
      match: cp.stateHash === currentHash,
      checkpointHash: cp.stateHash,
      currentHash
    };
  }
}
