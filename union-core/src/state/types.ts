export type ProjectStatus = 'ACTIVE' | 'PAUSED' | 'ARCHIVED';

export type SessionStatus = 'OPEN' | 'CLOSED';

export type DecisionStatus =
  | 'PROPOSED'
  | 'APPROVED'
  | 'FROZEN'
  | 'REOPENED'
  | 'REJECTED'
  | 'SUPERSEDED';

export interface Project {
  readonly projectId: string;
  readonly displayName: string;
  readonly status: ProjectStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface Session {
  readonly sessionId: string;
  readonly projectId: string;
  readonly status: SessionStatus;
  readonly startedAt: Date;
  readonly closedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

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
  readonly topic: string;
  readonly decision: string;
  readonly reason: string;
  readonly authority: string;
  readonly sessionId?: string | null;
  readonly alternativesConsidered?: unknown[] | null;
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

export type AuditAuthorityHolder = 'OWNER' | 'UNION';

export type AuditActor = 'OWNER' | 'UNION' | 'SYSTEM';

export type AuditAuthorityBasis =
  | 'OWNER_EXPLICIT'
  | 'OWNER_DELEGATED_ENVELOPE'
  | 'FROZEN_DECISION'
  | 'GOVERNANCE_RULE'
  | 'THIN_AUTHORITY'
  | 'SYSTEM_SAFETY_RULE';

export type AuditCoordinatedBy = 'UNION';

export type AuditExecutedBy =
  | 'UNION_CORE'
  | 'ANTIGRAVITY'
  | 'GITHUB'
  | 'RAILWAY';

export type AuditAction =
  | 'PROJECT_CREATED'
  | 'PROJECT_RENAMED'
  | 'PROJECT_STATUS_CHANGED'
  | 'SESSION_OPENED'
  | 'SESSION_CLOSED'
  | 'DECISION_CREATED'
  | 'DECISION_CONTENT_UPDATED'
  | 'DECISION_APPROVED'
  | 'DECISION_FROZEN'
  | 'DECISION_REOPENED'
  | 'DECISION_REJECTED'
  | 'DECISION_SUPERSEDED';

export type AuditResult = 'SUCCESS' | 'DENIED' | 'FAILED';

export interface AuditEvent {
  readonly auditEventId: string;
  readonly traceId: string;
  readonly projectId: string;
  readonly sessionId: string | null;
  readonly decisionId: string | null;
  readonly workOrderId: string | null;
  readonly actor: AuditActor;
  readonly action: AuditAction;
  readonly authorityHolder: AuditAuthorityHolder;
  readonly authorityBasis: AuditAuthorityBasis;
  readonly authorityReference: string | null;
  readonly coordinatedBy: AuditCoordinatedBy;
  readonly executedBy: AuditExecutedBy;
  readonly result: AuditResult;
  readonly provenance: Record<string, unknown> | null;
  readonly createdAt: Date;
}

export interface AuditContext {
  readonly traceId: string;
  readonly actor: AuditActor;
  readonly authorityHolder: AuditAuthorityHolder;
  readonly authorityBasis: AuditAuthorityBasis;
  readonly authorityReference?: string | null;
  readonly coordinatedBy: AuditCoordinatedBy;
  readonly executedBy: AuditExecutedBy;
  readonly provenance?: Record<string, unknown> | null;
}

export interface RecordAuditEventInput extends AuditContext {
  readonly projectId: string;
  readonly action: AuditAction;
  readonly result: AuditResult;
  readonly sessionId?: string | null;
  readonly decisionId?: string | null;
  readonly workOrderId?: string | null;
}
