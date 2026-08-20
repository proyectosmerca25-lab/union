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

export interface WorkOrderState {
  readonly workOrderId: string;
  readonly projectId: string;
  readonly sessionId: string | null;
  readonly parentWorkOrderId: string | null;
  readonly title: string;
  readonly objective: string;
  readonly status: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt: Date | null;
}

export interface EvidenceReferenceState {
  readonly evidenceReferenceId: string;
  readonly projectId: string;
  readonly sessionId: string | null;
  readonly decisionId: string | null;
  readonly workOrderId: string | null;
  readonly evidenceType: string;
  readonly provider: string;
  readonly externalReference: string;
  readonly checksum: string | null;
  readonly metadata: Record<string, unknown> | null;
  readonly createdAt: Date;
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
  | 'DECISION_SUPERSEDED'
  | 'CHECKPOINT_CREATED';

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

export type CheckpointType =
  | 'BOUNDARY'
  | 'PROTECTIVE_PRE'
  | 'PROTECTIVE_POST'
  | 'SESSION';

export type CheckpointTrigger =
  | 'BOUNDARY_FROZEN'
  | 'PRE_RISK_OPERATION'
  | 'POST_RISK_OPERATION'
  | 'SESSION_CLOSE'
  | 'PROJECT_PAUSE'
  | 'PROJECT_COMPLETION'
  | 'OWNER_REQUEST';

export interface CheckpointStateV1 {
  readonly version: 1;
  readonly projectId: string;
  readonly project: Project;
  readonly sessions: Session[];
  readonly decisions: Decision[];
  readonly workOrders: WorkOrderState[];
  readonly evidenceReferences: EvidenceReferenceState[];
  readonly activePhase?: string | null;
  readonly activeBlock?: string | null;
  readonly lastCompletedBoundary?: string | null;
  readonly openItems?: string[];
  readonly deferredItems?: string[];
  readonly blockers?: string[];
  readonly repositoryState?: Record<string, unknown> | null;
  readonly productionState?: Record<string, unknown> | null;
  readonly lastConfirmedAction?: string | null;
  readonly pendingWork?: string[];
  readonly nextRecommendedAction?: string | null;
}

export interface Checkpoint {
  readonly checkpointId: string;
  readonly projectId: string;
  readonly checkpointType: CheckpointType;
  readonly sequence: number;
  readonly stateSchemaVersion: number;
  readonly statePayload: CheckpointStateV1;
  readonly stateHash: string;
  readonly sessionId: string | null;
  readonly trigger: CheckpointTrigger;
  readonly operationTraceId: string | null;
  readonly actor: AuditActor;
  readonly authorityHolder: AuditAuthorityHolder;
  readonly authorityBasis: AuditAuthorityBasis;
  readonly authorityReference: string | null;
  readonly coordinatedBy: AuditCoordinatedBy;
  readonly executedBy: AuditExecutedBy;
  readonly traceId: string;
  readonly createdAt: Date;
}

export interface CreateCheckpointInput {
  readonly projectId: string;
  readonly checkpointType: CheckpointType;
  readonly trigger: CheckpointTrigger;
  readonly sessionId?: string | null;
  readonly operationTraceId?: string | null;
  readonly activePhase?: string | null;
  readonly activeBlock?: string | null;
  readonly lastCompletedBoundary?: string | null;
  readonly openItems?: string[];
  readonly deferredItems?: string[];
  readonly blockers?: string[];
  readonly repositoryState?: Record<string, unknown> | null;
  readonly productionState?: Record<string, unknown> | null;
  readonly lastConfirmedAction?: string | null;
  readonly pendingWork?: string[];
  readonly nextRecommendedAction?: string | null;
}
