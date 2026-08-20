-- UNIÓN F2.4 Migration — Checkpoint Foundation
-- Creates checkpoints table with composite candidate and foreign key constraints for project isolation.

CREATE TABLE IF NOT EXISTS checkpoints (
  checkpoint_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  checkpoint_type VARCHAR(50) NOT NULL,
  sequence BIGINT NOT NULL,
  state_schema_version INT NOT NULL DEFAULT 1,
  state_payload JSONB NOT NULL,
  state_hash VARCHAR(64) NOT NULL,
  session_id UUID,
  trigger VARCHAR(100) NOT NULL,
  operation_trace_id UUID,
  actor VARCHAR(100) NOT NULL,
  authority_holder VARCHAR(100) NOT NULL,
  authority_basis VARCHAR(100) NOT NULL,
  authority_reference TEXT,
  coordinated_by VARCHAR(100) NOT NULL,
  executed_by VARCHAR(100) NOT NULL,
  trace_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Uniqueness constraints
  CONSTRAINT uk_checkpoints_project_seq UNIQUE (project_id, sequence),
  CONSTRAINT uk_checkpoints_project_checkpoint UNIQUE (project_id, checkpoint_id),

  -- Composite Foreign Key Constraints enforcing same-project boundaries
  CONSTRAINT fk_checkpoints_project_session FOREIGN KEY (project_id, session_id)
    REFERENCES sessions(project_id, session_id) ON DELETE RESTRICT,

  -- Controlled Checkpoint Type Constraint
  CONSTRAINT chk_checkpoint_type CHECK (
    checkpoint_type IN ('BOUNDARY', 'PROTECTIVE_PRE', 'PROTECTIVE_POST', 'SESSION')
  )
);
