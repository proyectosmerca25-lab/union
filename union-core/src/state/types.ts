export type ProjectStatus = 'ACTIVE' | 'PAUSED' | 'ARCHIVED';

export interface Project {
  readonly projectId: string;
  readonly displayName: string;
  readonly status: ProjectStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type SessionStatus = 'OPEN' | 'CLOSED';

export interface Session {
  readonly sessionId: string;
  readonly projectId: string;
  readonly status: SessionStatus;
  readonly startedAt: Date;
  readonly closedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type DecisionStatus =
  | 'PROPOSED'
  | 'APPROVED'
  | 'FROZEN'
  | 'REOPENED'
  | 'SUPERSEDED'
  | 'REJECTED';

export interface Decision {
  readonly decisionId: string;
  readonly projectId: string;
  readonly sessionId: string | null;
  readonly topic: string;
  readonly decision: string;
  readonly status: DecisionStatus;
  readonly reason: string | null;
  readonly alternativesConsidered: unknown[] | null;
  readonly authority: string;
  readonly supersedesDecisionId: string | null;
  readonly reopenCondition: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly decidedAt: Date | null;
}

export interface CreateProjectInput {
  readonly displayName: string;
}

export interface CreateDecisionInput {
  readonly projectId: string;
  readonly sessionId?: string | null;
  readonly topic: string;
  readonly decision: string;
  readonly reason: string;
  readonly alternativesConsidered?: unknown[] | null;
  readonly authority: string;
}

export interface UpdateDecisionContentInput {
  readonly topic?: string;
  readonly decision?: string;
  readonly reason?: string | null;
  readonly alternativesConsidered?: unknown[] | null;
  readonly authority?: string;
}

export interface SupersedeDecisionInput {
  readonly predecessorDecisionId: string;
  readonly topic: string;
  readonly decision: string;
  readonly reason?: string | null;
  readonly alternativesConsidered?: unknown[] | null;
  readonly authority: string;
  readonly sessionId?: string | null;
}

export interface AuditEvent {
  readonly auditEventId: string;
  readonly traceId: string;
  readonly projectId: string;
  readonly sessionId: string | null;
  readonly decisionId: string | null;
  readonly workOrderId: string | null;
  readonly actor: string;
  readonly action: string;
  readonly authorityHolder: string;
  readonly authorityBasis: string;
  readonly authorityReference: string | null;
  readonly coordinatedBy: string;
  readonly executedBy: string;
  readonly result: string;
  readonly provenance: Record<string, unknown> | null;
  readonly createdAt: Date;
}

export interface AuditContext {
  readonly traceId: string;
  readonly actor: string;
  readonly authorityHolder: string;
  readonly authorityBasis: string;
  readonly authorityReference?: string | null;
  readonly coordinatedBy: string;
  readonly executedBy: string;
  readonly provenance?: Record<string, unknown> | null;
}

export interface RecordAuditEventInput extends AuditContext {
  readonly projectId: string;
  readonly action: string;
  readonly result: string;
  readonly sessionId?: string | null;
  readonly decisionId?: string | null;
  readonly workOrderId?: string | null;
}
