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
  EvidenceReferenceState,
  Project,
  Session,
  WorkOrderState
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

  /**
   * Internal shared state-builder that constructs a complete canonical CheckpointStateV1
   * for a project. Uses SELECT FOR UPDATE on the project row during writes to guarantee
   * consistent snapshot creation and project-scoped sequence serialization.
   */
  private async buildCanonicalProjectState(
    projectId: string,
    txClient: pg.ClientBase,
    contextInput?: Partial<CreateCheckpointInput>,
    forUpdate = true
  ): Promise<CheckpointStateV1> {
    // 1. Fetch Project row (with optional FOR UPDATE lock)
    const query = forUpdate
      ? 'SELECT * FROM projects WHERE project_id = $1 FOR UPDATE;'
      : 'SELECT * FROM projects WHERE project_id = $1;';
    const projRes = await txClient.query(query, [projectId]);
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

    // 2. Query all Sessions belonging to Project (ordered by session_id)
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

    // 3. Query all Decisions belonging to Project (ordered by decision_id)
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

    // 4. Query all Work Orders belonging to Project (ordered by work_order_id)
    const workOrdersRes = await txClient.query(
      'SELECT * FROM work_orders WHERE project_id = $1 ORDER BY work_order_id ASC;',
      [projectId]
    );
    const workOrders: WorkOrderState[] = workOrdersRes.rows.map(r => ({
      workOrderId: r.work_order_id,
      projectId: r.project_id,
      sessionId: r.session_id || null,
      parentWorkOrderId: r.parent_work_order_id || null,
      title: r.title,
      objective: r.objective,
      status: r.status,
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
      completedAt: r.completed_at ? new Date(r.completed_at) : null
    }));

    // 5. Query all Evidence References belonging to Project (ordered by evidence_reference_id)
    const evidenceRes = await txClient.query(
      'SELECT * FROM evidence_references WHERE project_id = $1 ORDER BY evidence_reference_id ASC;',
      [projectId]
    );
    const evidenceReferences: EvidenceReferenceState[] = evidenceRes.rows.map(r => ({
      evidenceReferenceId: r.evidence_reference_id,
      projectId: r.project_id,
      sessionId: r.session_id || null,
      decisionId: r.decision_id || null,
      workOrderId: r.work_order_id || null,
      evidenceType: r.evidence_type,
      provider: r.provider,
      externalReference: r.external_reference,
      checksum: r.checksum || null,
      metadata: r.metadata ? (typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata) : null,
      createdAt: new Date(r.created_at)
    }));

    return {
      version: 1,
      projectId,
      project,
      sessions,
      decisions,
      workOrders,
      evidenceReferences,
      activePhase: contextInput?.activePhase ?? null,
      activeBlock: contextInput?.activeBlock ?? null,
      lastCompletedBoundary: contextInput?.lastCompletedBoundary ?? null,
      openItems: contextInput?.openItems ? [...contextInput.openItems].sort() : [],
      deferredItems: contextInput?.deferredItems ? [...contextInput.deferredItems].sort() : [],
      blockers: contextInput?.blockers ? [...contextInput.blockers].sort() : [],
      repositoryState: contextInput?.repositoryState ?? null,
      productionState: contextInput?.productionState ?? null,
      lastConfirmedAction: contextInput?.lastConfirmedAction ?? null,
      pendingWork: contextInput?.pendingWork ? [...contextInput.pendingWork] : [],
      nextRecommendedAction: contextInput?.nextRecommendedAction ?? null
    };
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

      // 1. Build canonical state (locks project row with SELECT FOR UPDATE)
      const statePayload = await this.buildCanonicalProjectState(projectId, txClient, input, true);

      // 2. Validate session if provided (same-project ownership check)
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

      // 3. Concurrency-safe Sequence Allocation (serialized by project row FOR UPDATE lock)
      const seqRes = await txClient.query(
        'SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq FROM checkpoints WHERE project_id = $1;',
        [projectId]
      );
      const sequence = Number(seqRes.rows[0].next_seq);

      // 4. Compute state hash
      const stateHash = computeStateHash(statePayload);

      // 5. Insert checkpoint row
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

      // 6. Transactional Audit Event
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

    const isPool = 'totalCount' in this.client || 'idleCount' in this.client;
    const txClient = isPool ? await (this.client as pg.Pool).connect() : (this.client as pg.Client);

    try {
      if (isPool) await txClient.query('BEGIN READ ONLY;');

      const currentStatePayload = await this.buildCanonicalProjectState(projectId, txClient, cp.statePayload, false);
      const currentHash = computeStateHash(currentStatePayload);

      if (isPool) await txClient.query('COMMIT;');

      return {
        match: cp.stateHash === currentHash,
        checkpointHash: cp.stateHash,
        currentHash
      };
    } finally {
      if (isPool) (txClient as pg.PoolClient).release();
    }
  }
}
