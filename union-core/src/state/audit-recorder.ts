import pg from 'pg';
import {
  AuditAction,
  AuditActor,
  AuditAuthorityBasis,
  AuditAuthorityHolder,
  AuditCoordinatedBy,
  AuditEvent,
  AuditExecutedBy,
  AuditResult,
  RecordAuditEventInput
} from './types.js';
import {
  DatabaseFailureError,
  InvalidInputError,
  NotFoundError
} from './errors.js';

const ALLOWED_AUTHORITY_HOLDERS: ReadonlySet<string> = new Set(['OWNER', 'UNION']);
const ALLOWED_ACTORS: ReadonlySet<string> = new Set(['OWNER', 'UNION', 'SYSTEM']);
const ALLOWED_AUTHORITY_BASES: ReadonlySet<string> = new Set([
  'OWNER_EXPLICIT',
  'OWNER_DELEGATED_ENVELOPE',
  'FROZEN_DECISION',
  'GOVERNANCE_RULE',
  'THIN_AUTHORITY',
  'SYSTEM_SAFETY_RULE'
]);
const ALLOWED_COORDINATED_BY: ReadonlySet<string> = new Set(['UNION']);
const ALLOWED_EXECUTED_BY: ReadonlySet<string> = new Set([
  'UNION_CORE',
  'ANTIGRAVITY',
  'GITHUB',
  'RAILWAY'
]);
const ALLOWED_ACTIONS: ReadonlySet<string> = new Set([
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
  'DECISION_SUPERSEDED',
  'CHECKPOINT_CREATED'
]);
const ALLOWED_RESULTS: ReadonlySet<string> = new Set(['SUCCESS', 'DENIED', 'FAILED']);

function mapRowToAuditEvent(row: any): AuditEvent {
  let provenanceData: Record<string, unknown> | null = null;
  if (row.provenance !== null && row.provenance !== undefined) {
    provenanceData = typeof row.provenance === 'string'
      ? JSON.parse(row.provenance)
      : row.provenance;
  }

  return {
    auditEventId: row.audit_event_id,
    traceId: row.trace_id,
    projectId: row.project_id,
    sessionId: row.session_id || null,
    decisionId: row.decision_id || null,
    workOrderId: row.work_order_id || null,
    actor: row.actor as AuditActor,
    action: row.action as AuditAction,
    authorityHolder: row.authority_holder as AuditAuthorityHolder,
    authorityBasis: row.authority_basis as AuditAuthorityBasis,
    authorityReference: row.authority_reference || null,
    coordinatedBy: row.coordinated_by as AuditCoordinatedBy,
    executedBy: row.executed_by as AuditExecutedBy,
    result: row.result as AuditResult,
    provenance: provenanceData,
    createdAt: new Date(row.created_at)
  };
}

export class AuditRecorder {
  constructor(private readonly client: pg.Client | pg.Pool | pg.ClientBase) {}

  async recordAuditEvent(
    input: RecordAuditEventInput,
    clientOverride?: pg.ClientBase
  ): Promise<AuditEvent> {
    if (!input) {
      throw new InvalidInputError('RecordAuditEventInput is required');
    }

    // Required string non-emptiness checks
    if (!input.traceId || typeof input.traceId !== 'string' || input.traceId.trim() === '') {
      throw new InvalidInputError('traceId is required for audit recording');
    }
    if (!input.projectId || typeof input.projectId !== 'string' || input.projectId.trim() === '') {
      throw new InvalidInputError('projectId is required for audit recording');
    }
    if (!input.actor || typeof input.actor !== 'string' || input.actor.trim() === '') {
      throw new InvalidInputError('actor is required for audit recording');
    }
    if (!input.action || typeof input.action !== 'string' || input.action.trim() === '') {
      throw new InvalidInputError('action is required for audit recording');
    }
    if (!input.authorityHolder || typeof input.authorityHolder !== 'string' || input.authorityHolder.trim() === '') {
      throw new InvalidInputError('authorityHolder is required for audit recording');
    }
    if (!input.authorityBasis || typeof input.authorityBasis !== 'string' || input.authorityBasis.trim() === '') {
      throw new InvalidInputError('authorityBasis is required for audit recording');
    }
    if (!input.coordinatedBy || typeof input.coordinatedBy !== 'string' || input.coordinatedBy.trim() === '') {
      throw new InvalidInputError('coordinatedBy is required for audit recording');
    }
    if (!input.executedBy || typeof input.executedBy !== 'string' || input.executedBy.trim() === '') {
      throw new InvalidInputError('executedBy is required for audit recording');
    }
    if (!input.result || typeof input.result !== 'string' || input.result.trim() === '') {
      throw new InvalidInputError('result is required for audit recording');
    }

    const trimmedAuthorityHolder = input.authorityHolder.trim();
    const trimmedActor = input.actor.trim();
    const trimmedAuthorityBasis = input.authorityBasis.trim();
    const trimmedCoordinatedBy = input.coordinatedBy.trim();
    const trimmedExecutedBy = input.executedBy.trim();
    const trimmedAction = input.action.trim();
    const trimmedResult = input.result.trim();

    // 1. FAIL-CLOSED ALLOWLIST VALIDATIONS
    if (!ALLOWED_AUTHORITY_HOLDERS.has(trimmedAuthorityHolder)) {
      throw new InvalidInputError(
        `Invalid authority_holder: '${input.authorityHolder}' is not in allowed list [OWNER, UNION]`
      );
    }

    if (!ALLOWED_ACTORS.has(trimmedActor)) {
      throw new InvalidInputError(
        `Invalid actor: '${input.actor}' is not in allowed list [OWNER, UNION, SYSTEM]`
      );
    }

    if (!ALLOWED_AUTHORITY_BASES.has(trimmedAuthorityBasis)) {
      throw new InvalidInputError(
        `Invalid authority_basis: '${input.authorityBasis}' is not in allowed list [OWNER_EXPLICIT, OWNER_DELEGATED_ENVELOPE, FROZEN_DECISION, GOVERNANCE_RULE, THIN_AUTHORITY, SYSTEM_SAFETY_RULE]`
      );
    }

    if (!ALLOWED_COORDINATED_BY.has(trimmedCoordinatedBy)) {
      throw new InvalidInputError(
        `Invalid coordinated_by: '${input.coordinatedBy}' must equal 'UNION'`
      );
    }

    if (!ALLOWED_EXECUTED_BY.has(trimmedExecutedBy)) {
      throw new InvalidInputError(
        `Invalid executed_by: '${input.executedBy}' is not in allowed list [UNION_CORE, ANTIGRAVITY, GITHUB, RAILWAY]`
      );
    }

    if (!ALLOWED_ACTIONS.has(trimmedAction)) {
      throw new InvalidInputError(
        `Invalid action: '${input.action}' is not a recognized audit action`
      );
    }

    if (!ALLOWED_RESULTS.has(trimmedResult)) {
      throw new InvalidInputError(
        `Invalid result: '${input.result}' must be one of: SUCCESS, DENIED, FAILED`
      );
    }

    const targetClient = clientOverride || (this.client as pg.ClientBase);
    const provJson = input.provenance ? JSON.stringify(input.provenance) : null;

    try {
      const res = await targetClient.query(
        `INSERT INTO audit_events (
           trace_id, project_id, session_id, decision_id, work_order_id,
           actor, action, authority_holder, authority_basis, authority_reference,
           coordinated_by, executed_by, result, provenance
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING *;`,
        [
          input.traceId.trim(),
          input.projectId.trim(),
          input.sessionId || null,
          input.decisionId || null,
          input.workOrderId || null,
          trimmedActor,
          trimmedAction,
          trimmedAuthorityHolder,
          trimmedAuthorityBasis,
          input.authorityReference ? input.authorityReference.trim() : null,
          trimmedCoordinatedBy,
          trimmedExecutedBy,
          trimmedResult,
          provJson
        ]
      );
      return mapRowToAuditEvent(res.rows[0]);
    } catch (err: unknown) {
      if (err instanceof InvalidInputError) throw err;
      if (typeof err === 'object' && err !== null && 'code' in err) {
        const pgErr = err as { code: string };
        if (pgErr.code === '23503') { // foreign key violation
          throw new NotFoundError('Referenced record not found during audit recording');
        }
      }
      throw new DatabaseFailureError('Failed to record audit event');
    }
  }

  async getAuditEvent(auditEventId: string): Promise<AuditEvent> {
    if (!auditEventId || auditEventId.trim() === '') {
      throw new InvalidInputError('auditEventId is required');
    }
    try {
      const res = await this.client.query(
        `SELECT * FROM audit_events WHERE audit_event_id = $1;`,
        [auditEventId]
      );
      if (res.rows.length === 0) {
        throw new NotFoundError(`Audit event not found with audit_event_id: '${auditEventId}'`);
      }
      return mapRowToAuditEvent(res.rows[0]);
    } catch (err: unknown) {
      if (err instanceof NotFoundError || err instanceof InvalidInputError) throw err;
      throw new DatabaseFailureError('Failed to fetch audit event');
    }
  }

  async listProjectAuditEvents(projectId: string): Promise<AuditEvent[]> {
    if (!projectId || projectId.trim() === '') {
      throw new InvalidInputError('projectId is required');
    }
    try {
      const res = await this.client.query(
        `SELECT * FROM audit_events WHERE project_id = $1 ORDER BY created_at ASC;`,
        [projectId]
      );
      return res.rows.map(mapRowToAuditEvent);
    } catch (err: unknown) {
      if (err instanceof NotFoundError || err instanceof InvalidInputError) throw err;
      throw new DatabaseFailureError('Failed to list audit events for project');
    }
  }
}
