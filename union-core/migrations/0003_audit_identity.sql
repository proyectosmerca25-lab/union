-- UNIÓN F2.3 Migration — Audit Identity & Authority Provenance Foundation
-- Creates audit_events table with composite candidate and foreign key constraints for project isolation.

CREATE TABLE IF NOT EXISTS audit_events (
  audit_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id UUID NOT NULL,
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  session_id UUID,
  decision_id UUID,
  work_order_id UUID,
  actor VARCHAR(100) NOT NULL,
  action VARCHAR(100) NOT NULL,
  authority_holder VARCHAR(100) NOT NULL,
  authority_basis VARCHAR(100) NOT NULL,
  authority_reference TEXT,
  coordinated_by VARCHAR(100) NOT NULL,
  executed_by VARCHAR(100) NOT NULL,
  result VARCHAR(50) NOT NULL,
  provenance JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Composite candidate key for same-project isolation
  CONSTRAINT uk_audit_events_project_audit UNIQUE (project_id, audit_event_id),

  -- Composite Foreign Key Constraints enforcing same-project boundaries
  CONSTRAINT fk_audit_events_project_session FOREIGN KEY (project_id, session_id)
    REFERENCES sessions(project_id, session_id) ON DELETE RESTRICT,
  CONSTRAINT fk_audit_events_project_decision FOREIGN KEY (project_id, decision_id)
    REFERENCES decisions(project_id, decision_id) ON DELETE RESTRICT,
  CONSTRAINT fk_audit_events_project_work_order FOREIGN KEY (project_id, work_order_id)
    REFERENCES work_orders(project_id, work_order_id) ON DELETE RESTRICT
);
