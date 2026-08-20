-- UNIÓN Foundation Migration 0001: Schema Migrations Metadata Table
CREATE TABLE IF NOT EXISTS union_schema_migrations (
  migration_id VARCHAR(255) PRIMARY KEY,
  filename VARCHAR(255) NOT NULL,
  checksum VARCHAR(64) NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
