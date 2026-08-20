-- UNIÓN F2.4 Migration — Checkpoint Foundation
-- Creates checkpoints table with composite candidate and foreign key constraints for project isolation.
-- Includes persistence-level immutability trigger preventing UPDATE and DELETE.

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

-- Persistence-Level Checkpoint Immutability Trigger
CREATE OR REPLACE FUNCTION enforce_checkpoint_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'CHECKPOINT_IMMUTABILITY_VIOLATION: Sealed checkpoints cannot be UPDATEd';
  ELSIF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CHECKPOINT_IMMUTABILITY_VIOLATION: Sealed checkpoints cannot be DELETEd';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_checkpoints_immutability ON checkpoints;
CREATE TRIGGER trg_checkpoints_immutability
BEFORE UPDATE OR DELETE ON checkpoints
FOR EACH ROW
EXECUTE FUNCTION enforce_checkpoint_immutability();
