import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import {
  computeChecksum,
  runMigrations
} from './runner.js';

function getTestConfig() {
  const password = process.env.POSTGRES_PASSWORD ?? 'local_f1_5_c1_secret_key';
  return {
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
    database: process.env.POSTGRES_DB ?? 'union',
    user: process.env.POSTGRES_USER ?? 'union_app',
    password,
    migrationsDir: path.resolve(process.cwd(), 'migrations'),
    env: 'local',
    databaseEnv: 'local'
  };
}

async function cleanDatabase(config = getTestConfig()) {
  const client = new pg.Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password
  });
  await client.connect();
  try {
    await client.query('DROP TABLE IF EXISTS evidence_references CASCADE;');
    await client.query('DROP TABLE IF EXISTS decision_work_orders CASCADE;');
    await client.query('DROP TABLE IF EXISTS work_orders CASCADE;');
    await client.query('DROP TABLE IF EXISTS decisions CASCADE;');
    await client.query('DROP TABLE IF EXISTS sessions CASCADE;');
    await client.query('DROP TABLE IF EXISTS projects CASCADE;');
    await client.query('DROP TABLE IF EXISTS union_schema_migrations CASCADE;');
  } finally {
    await client.end();
  }
}

test('F2.1 CANONICAL STATE SCHEMA FOUNDATION TEST SUITE (T01 - T34)', async () => {
  const config = getTestConfig();
  await cleanDatabase(config);

  // T01: 0001 -> 0002 clean migration = PASS
  const firstRun = await runMigrations(config);
  assert.equal(firstRun.appliedCount, 2);
  assert.equal(firstRun.alreadyAppliedCount, 0);
  assert.deepEqual(firstRun.migrations, ['0001_migration_foundation.sql', '0002_canonical_state.sql']);

  // T27: Second migration-runner execution = IDEMPOTENT / PASS
  const secondRun = await runMigrations(config);
  assert.equal(secondRun.appliedCount, 0);
  assert.equal(secondRun.alreadyAppliedCount, 2);

  const client = new pg.Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password
  });
  await client.connect();

  try {
    // T02 & T33: Exactly six new domain tables + union_schema_migrations
    const tableRes = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;"
    );
    const tables = tableRes.rows.map(r => r.table_name);
    const expectedTables = [
      'decision_work_orders',
      'decisions',
      'evidence_references',
      'projects',
      'sessions',
      'union_schema_migrations',
      'work_orders'
    ];
    assert.deepEqual(tables, expectedTables);

    // T24: All canonical timestamps use TIMESTAMPTZ
    const timestampTypesRes = await client.query<{ table_name: string; column_name: string; data_type: string }>(
      "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND column_name LIKE '%_at';"
    );
    for (const row of timestampTypesRes.rows) {
      assert.equal(
        row.data_type,
        'timestamp with time zone',
        `Column ${row.table_name}.${row.column_name} must be TIMESTAMPTZ`
      );
    }

    // T25: Canonical IDs are UUID
    const uuidColsRes = await client.query<{ table_name: string; column_name: string; data_type: string }>(
      "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND column_name LIKE '%_id';"
    );
    for (const row of uuidColsRes.rows) {
      if (row.table_name === 'union_schema_migrations') continue;
      assert.equal(
        row.data_type,
        'uuid',
        `Column ${row.table_name}.${row.column_name} must be UUID`
      );
    }

    // T26: No ON DELETE CASCADE
    const cascadeRes = await client.query<{ delete_rule: string }>(
      "SELECT delete_rule FROM information_schema.referential_constraints WHERE constraint_schema = 'public';"
    );
    for (const row of cascadeRes.rows) {
      assert.notEqual(row.delete_rule, 'CASCADE', 'No ON DELETE CASCADE allowed in canonical state');
    }

    // T28: Migration checksum integrity = PASS
    const fileContent = await fs.readFile(path.join(config.migrationsDir, '0002_canonical_state.sql'), 'utf8');
    const expectedChecksum = computeChecksum(fileContent);
    const historyRes = await client.query<{ checksum: string }>(
      "SELECT checksum FROM union_schema_migrations WHERE migration_id = '0002';"
    );
    assert.equal(historyRes.rows[0].checksum, expectedChecksum);

    // Setup Test Data (Project 1 & Project 2)
    const p1Res = await client.query<{ project_id: string }>(
      "INSERT INTO projects (display_name, status) VALUES ('Project UNIÓN Alpha', 'ACTIVE') RETURNING project_id;"
    );
    const p1Id = p1Res.rows[0].project_id;
    assert.ok(p1Id);

    const p2Res = await client.query<{ project_id: string }>(
      "INSERT INTO projects (display_name, status) VALUES ('Project KYRONS Beta', 'ACTIVE') RETURNING project_id;"
    );
    const p2Id = p2Res.rows[0].project_id;
    assert.ok(p2Id);

    // T06: project status invalid value = REJECTED
    await assert.rejects(async () => {
      await client.query("INSERT INTO projects (display_name, status) VALUES ('Invalid', 'DELETED');");
    });

    // T05: required NOT NULL constraint = REJECTED
    await assert.rejects(async () => {
      await client.query("INSERT INTO projects (display_name, status) VALUES (NULL, 'ACTIVE');");
    });

    // T07: session status invalid value = REJECTED
    await assert.rejects(async () => {
      await client.query("INSERT INTO sessions (project_id, status) VALUES ($1, 'REOPENED');", [p1Id]);
    });

    // T08: OPEN session with closed_at populated = REJECTED
    await assert.rejects(async () => {
      await client.query("INSERT INTO sessions (project_id, status, closed_at) VALUES ($1, 'OPEN', CURRENT_TIMESTAMP);", [p1Id]);
    });

    // T09: CLOSED session without closed_at = REJECTED
    await assert.rejects(async () => {
      await client.query("INSERT INTO sessions (project_id, status, closed_at) VALUES ($1, 'CLOSED', NULL);", [p1Id]);
    });

    // T04 & T08 & T09: Valid OPEN and CLOSED sessions
    const s1Res = await client.query<{ session_id: string }>(
      "INSERT INTO sessions (project_id, status) VALUES ($1, 'OPEN') RETURNING session_id;",
      [p1Id]
    );
    const s1Id = s1Res.rows[0].session_id;

    const s2Res = await client.query<{ session_id: string }>(
      "INSERT INTO sessions (project_id, status, closed_at) VALUES ($1, 'CLOSED', CURRENT_TIMESTAMP) RETURNING session_id;",
      [p2Id]
    );
    const s2Id = s2Res.rows[0].session_id;

    // T10: decision invalid status = REJECTED
    await assert.rejects(async () => {
      await client.query(
        "INSERT INTO decisions (project_id, topic, decision, status, reason, authority) VALUES ($1, 'T', 'D', 'PENDING', 'R', 'Auth');",
        [p1Id]
      );
    });

    // Valid Decisions
    const d1Res = await client.query<{ decision_id: string }>(
      "INSERT INTO decisions (project_id, session_id, topic, decision, status, reason, authority) VALUES ($1, $2, 'Topic 1', 'Decision 1', 'APPROVED', 'Reason 1', 'Omar') RETURNING decision_id;",
      [p1Id, s1Id]
    );
    const d1Id = d1Res.rows[0].decision_id;

    // T11: decision supersedes itself = REJECTED
    const selfUuid = '11111111-1111-1111-1111-111111111111';
    await assert.rejects(async () => {
      await client.query(
        "INSERT INTO decisions (decision_id, project_id, topic, decision, status, reason, authority, supersedes_decision_id) VALUES ($1, $2, 'T', 'D', 'SUPERSEDED', 'R', 'Auth', $1);",
        [selfUuid, p1Id]
      );
    });
    await assert.rejects(async () => {
      await client.query(
        "UPDATE decisions SET supersedes_decision_id = decision_id WHERE decision_id = $1;",
        [d1Id]
      );
    });

    // T12: work_order invalid status = REJECTED
    await assert.rejects(async () => {
      await client.query(
        "INSERT INTO work_orders (project_id, title, objective, status) VALUES ($1, 'Title', 'Obj', 'PLANNED');",
        [p1Id]
      );
    });

    // Valid Work Order
    const wo1Res = await client.query<{ work_order_id: string }>(
      "INSERT INTO work_orders (project_id, session_id, title, objective, status) VALUES ($1, $2, 'WO 1', 'Objective 1', 'READY') RETURNING work_order_id;",
      [p1Id, s1Id]
    );
    const wo1Id = wo1Res.rows[0].work_order_id;

    const wo2Res = await client.query<{ work_order_id: string }>(
      "INSERT INTO work_orders (project_id, session_id, title, objective, status) VALUES ($1, $2, 'WO 2', 'Objective 2', 'READY') RETURNING work_order_id;",
      [p2Id, s2Id]
    );
    const wo2Id = wo2Res.rows[0].work_order_id;

    // T13: work_order parent self-reference = REJECTED
    await assert.rejects(async () => {
      await client.query(
        "UPDATE work_orders SET parent_work_order_id = work_order_id WHERE work_order_id = $1;",
        [wo1Id]
      );
    });

    // T14: non-existent referenced entities = REJECTED
    const fakeUuid = '00000000-0000-0000-0000-000000000000';
    await assert.rejects(async () => {
      await client.query("INSERT INTO sessions (project_id, status) VALUES ($1, 'OPEN');", [fakeUuid]);
    });

    // T15: cross-project session relation (FK to non-existent project)
    await assert.rejects(async () => {
      await client.query("INSERT INTO sessions (project_id, status) VALUES ($1, 'OPEN');", [fakeUuid]);
    });

    // T16: cross-project decision relation = REJECTED (Decision for P1 referencing Session from P2)
    await assert.rejects(async () => {
      await client.query(
        "INSERT INTO decisions (project_id, session_id, topic, decision, status, reason, authority) VALUES ($1, $2, 'T', 'D', 'PROPOSED', 'R', 'A');",
        [p1Id, s2Id] // s2 belongs to p2!
      );
    });

    // T17: cross-project parent Work Order = REJECTED (WO in P1 referencing parent WO in P2)
    await assert.rejects(async () => {
      await client.query(
        "INSERT INTO work_orders (project_id, parent_work_order_id, title, objective, status) VALUES ($1, $2, 'Child WO', 'Obj', 'DRAFT');",
        [p1Id, wo2Id] // wo2 belongs to p2!
      );
    });

    // T18: cross-project Decision <-> Work Order relation = REJECTED
    await assert.rejects(async () => {
      await client.query(
        "INSERT INTO decision_work_orders (decision_id, work_order_id, project_id) VALUES ($1, $2, $3);",
        [d1Id, wo2Id, p1Id] // d1 belongs to p1, wo2 belongs to p2!
      );
    });

    // T19: cross-project Evidence relation = REJECTED
    await assert.rejects(async () => {
      await client.query(
        "INSERT INTO evidence_references (project_id, session_id, evidence_type, provider, external_reference) VALUES ($1, $2, 'TEST_RESULT', 'Jest', 'ref-1');",
        [p1Id, s2Id] // s2 belongs to p2!
      );
    });

    // T20: Decision N:M Work Order valid relationship = PASS
    await client.query(
      "INSERT INTO decision_work_orders (decision_id, work_order_id, project_id) VALUES ($1, $2, $3);",
      [d1Id, wo1Id, p1Id]
    );
    const dwoRes = await client.query("SELECT * FROM decision_work_orders WHERE decision_id = $1 AND work_order_id = $2;", [d1Id, wo1Id]);
    assert.equal(dwoRes.rows.length, 1);

    // T21 & T22: Evidence reference valid with external reference only = PASS
    const evRes = await client.query<{ evidence_reference_id: string }>(
      "INSERT INTO evidence_references (project_id, evidence_type, provider, external_reference) VALUES ($1, 'GITHUB_COMMIT', 'GitHub', 'b6d104627c0f518bec9d8a859b9492b721d31687') RETURNING evidence_reference_id;",
      [p1Id]
    );
    assert.ok(evRes.rows[0].evidence_reference_id);

    // T23: delete parent with protected canonical dependents = REJECTED (RESTRICT)
    await assert.rejects(async () => {
      await client.query("DELETE FROM projects WHERE project_id = $1;", [p1Id]);
    });

    // T03: Primary Key constraint violation on duplicate PK
    await assert.rejects(async () => {
      await client.query(
        "INSERT INTO projects (project_id, display_name, status) VALUES ($1, 'Dup', 'ACTIVE');",
        [p1Id]
      );
    });

  } finally {
    await client.end();
  }
});
