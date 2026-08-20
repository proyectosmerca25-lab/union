-- Migration 0002: Canonical State Schema Foundation

-- 1. PROJECTS
CREATE TABLE IF NOT EXISTS projects (
  project_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name TEXT NOT NULL,
  status VARCHAR(50) NOT NULL CHECK (status IN ('ACTIVE', 'PAUSED', 'ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uk_projects_project_id UNIQUE (project_id)
);

-- 2. SESSIONS
CREATE TABLE IF NOT EXISTS sessions (
  session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  status VARCHAR(50) NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uk_sessions_project_session UNIQUE (project_id, session_id),
  CONSTRAINT chk_sessions_closed_at CHECK (
    (status = 'OPEN' AND closed_at IS NULL) OR
    (status = 'CLOSED' AND closed_at IS NOT NULL)
  )
);

-- 3. DECISIONS
CREATE TABLE IF NOT EXISTS decisions (
  decision_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  session_id UUID,
  topic TEXT NOT NULL,
  decision TEXT NOT NULL,
  status VARCHAR(50) NOT NULL CHECK (status IN ('PROPOSED', 'APPROVED', 'FROZEN', 'REOPENED', 'SUPERSEDED', 'REJECTED')),
  reason TEXT NOT NULL,
  alternatives_considered JSONB,
  authority TEXT NOT NULL,
  supersedes_decision_id UUID,
  reopen_condition TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at TIMESTAMPTZ,
  CONSTRAINT uk_decisions_project_decision UNIQUE (project_id, decision_id),
  CONSTRAINT chk_decisions_not_self_supersede CHECK (
    supersedes_decision_id IS NULL OR supersedes_decision_id <> decision_id
  ),
  CONSTRAINT fk_decisions_project_session FOREIGN KEY (project_id, session_id)
    REFERENCES sessions(project_id, session_id) ON DELETE RESTRICT,
  CONSTRAINT fk_decisions_project_supersedes FOREIGN KEY (project_id, supersedes_decision_id)
    REFERENCES decisions(project_id, decision_id) ON DELETE RESTRICT
);

-- 4. WORK_ORDERS
CREATE TABLE IF NOT EXISTS work_orders (
  work_order_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  session_id UUID,
  parent_work_order_id UUID,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  status VARCHAR(50) NOT NULL CHECK (status IN ('DRAFT', 'READY', 'IN_PROGRESS', 'IMPLEMENTATION_COMPLETE', 'VALIDATING', 'BLOCKED', 'UNCERTAIN', 'PASS', 'FAIL', 'CANCELLED', 'CLOSED')),
  scope_in JSONB,
  scope_out JSONB,
  requirements JSONB,
  constraints JSONB,
  acceptance_criteria JSONB,
  required_evidence JSONB,
  execution_policy JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  authorized_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  implementation_completed_at TIMESTAMPTZ,
  validation_completed_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  CONSTRAINT uk_work_orders_project_work_order UNIQUE (project_id, work_order_id),
  CONSTRAINT chk_work_orders_not_self_parent CHECK (
    parent_work_order_id IS NULL OR parent_work_order_id <> work_order_id
  ),
  CONSTRAINT fk_work_orders_project_session FOREIGN KEY (project_id, session_id)
    REFERENCES sessions(project_id, session_id) ON DELETE RESTRICT,
  CONSTRAINT fk_work_orders_project_parent FOREIGN KEY (project_id, parent_work_order_id)
    REFERENCES work_orders(project_id, work_order_id) ON DELETE RESTRICT
);

-- 5. DECISION_WORK_ORDERS
CREATE TABLE IF NOT EXISTS decision_work_orders (
  decision_id UUID NOT NULL,
  work_order_id UUID NOT NULL,
  project_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (decision_id, work_order_id),
  CONSTRAINT fk_dwo_project FOREIGN KEY (project_id)
    REFERENCES projects(project_id) ON DELETE RESTRICT,
  CONSTRAINT fk_dwo_project_decision FOREIGN KEY (project_id, decision_id)
    REFERENCES decisions(project_id, decision_id) ON DELETE RESTRICT,
  CONSTRAINT fk_dwo_project_work_order FOREIGN KEY (project_id, work_order_id)
    REFERENCES work_orders(project_id, work_order_id) ON DELETE RESTRICT
);

-- 6. EVIDENCE_REFERENCES
CREATE TABLE IF NOT EXISTS evidence_references (
  evidence_reference_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  session_id UUID,
  work_order_id UUID,
  decision_id UUID,
  evidence_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_reference TEXT NOT NULL,
  result TEXT,
  baseline TEXT,
  verification_status TEXT,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_evidence_project_session FOREIGN KEY (project_id, session_id)
    REFERENCES sessions(project_id, session_id) ON DELETE RESTRICT,
  CONSTRAINT fk_evidence_project_work_order FOREIGN KEY (project_id, work_order_id)
    REFERENCES work_orders(project_id, work_order_id) ON DELETE RESTRICT,
  CONSTRAINT fk_evidence_project_decision FOREIGN KEY (project_id, decision_id)
    REFERENCES decisions(project_id, decision_id) ON DELETE RESTRICT
);
