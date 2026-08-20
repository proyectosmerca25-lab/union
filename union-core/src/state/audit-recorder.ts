import pg from 'pg';
import { AuditEvent, RecordAuditEventInput } from './types.js';
import {
  DatabaseFailureError,
  InvalidInputError,
  NotFoundError
} from './errors.js';

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
    actor: row.actor,
    action: row.action,
    authorityHolder: row.authority_holder,
    authorityBasis: row.authority_basis,
    authorityReference: row.authority_reference || null,
    coordinatedBy: row.coordinated_by,
    executedBy: row.executed_by,
    result: row.result,
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
    if (!input.traceId || input.traceId.trim() === '') {
      throw new InvalidInputError('traceId is required for audit recording');
    }
    if (!input.projectId || input.projectId.trim() === '') {
      throw new InvalidInputError('projectId is required for audit recording');
    }
    if (!input.actor || input.actor.trim() === '') {
      throw new InvalidInputError('actor is required for audit recording');
    }
    if (!input.action || input.action.trim() === '') {
      throw new InvalidInputError('action is required for audit recording');
    }
    if (!input.authorityHolder || input.authorityHolder.trim() === '') {
      throw new InvalidInputError('authorityHolder is required for audit recording');
    }
    if (!input.authorityBasis || input.authorityBasis.trim() === '') {
      throw new InvalidInputError('authorityBasis is required for audit recording');
    }
    if (!input.coordinatedBy || input.coordinatedBy.trim() === '') {
      throw new InvalidInputError('coordinatedBy is required for audit recording');
    }
    if (!input.executedBy || input.executedBy.trim() === '') {
      throw new InvalidInputError('executedBy is required for audit recording');
    }
    if (!input.result || input.result.trim() === '') {
      throw new InvalidInputError('result is required for audit recording');
    }

    const disallowedAuthorityHolders = [
      'ANTIGRAVITY',
      'GITHUB',
      'TENCENT',
      'GRAPHIFY',
      'OPENAI',
      'RAILWAY'
    ];
    if (disallowedAuthorityHolders.includes(input.authorityHolder.trim().toUpperCase())) {
      throw new InvalidInputError(
        `Invalid authority_holder: Capabilities/tools cannot possess authority ('${input.authorityHolder}')`
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
          input.actor.trim(),
          input.action.trim(),
          input.authorityHolder.trim(),
          input.authorityBasis.trim(),
          input.authorityReference ? input.authorityReference.trim() : null,
          input.coordinatedBy.trim(),
          input.executedBy.trim(),
          input.result.trim(),
          provJson
        ]
      );
      return mapRowToAuditEvent(res.rows[0]);
    } catch (err: unknown) {
      if (err instanceof InvalidInputError) throw err;
      if (typeof err === 'object' && err !== null && 'code' in err) {
        const pgErr = err as { code: string; message?: string };
        if (pgErr.code === '23503') { // foreign key violation
          throw new NotFoundError(`Foreign key reference not found during audit recording: ${pgErr.message}`);
        }
      }
      throw new DatabaseFailureError('Failed to record audit event', err);
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
      throw new DatabaseFailureError(`Failed to fetch audit event '${auditEventId}'`, err);
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
      throw new DatabaseFailureError(`Failed to list audit events for project '${projectId}'`, err);
    }
  }
}
