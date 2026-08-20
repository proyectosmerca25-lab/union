import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

export const ADVISORY_LOCK_ID = 8641001;

export class MissingDatabaseConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingDatabaseConfigurationError';
  }
}

export class MalformedMigrationIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedMigrationIdentityError';
  }
}

export class DuplicateMigrationIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateMigrationIdentityError';
  }
}

export class ChecksumMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChecksumMismatchError';
  }
}

export interface MigrationConfig {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  migrationsDir?: string;
}

export interface DiscoveredMigration {
  id: string;
  filename: string;
  fullPath: string;
  content: string;
  checksum: string;
}

export interface MigrationResult {
  appliedCount: number;
  alreadyAppliedCount: number;
  migrations: string[];
}

export function computeChecksum(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export function getResolvedConfig(customConfig: MigrationConfig = {}): Required<MigrationConfig> {
  const host = customConfig.host ?? process.env.POSTGRES_HOST ?? 'localhost';
  const portStr = customConfig.port ?? process.env.POSTGRES_PORT ?? 5432;
  const port = typeof portStr === 'number' ? portStr : parseInt(String(portStr), 10);
  const database = customConfig.database ?? process.env.POSTGRES_DB ?? 'union';
  const user = customConfig.user ?? process.env.POSTGRES_USER ?? 'union_app';
  const password = customConfig.password ?? process.env.POSTGRES_PASSWORD;
  const migrationsDir = customConfig.migrationsDir ?? path.resolve(process.cwd(), 'migrations');

  if (!password || password.trim() === '') {
    throw new MissingDatabaseConfigurationError(
      'Missing required database configuration: POSTGRES_PASSWORD is required and cannot be empty'
    );
  }

  return {
    host,
    port,
    database,
    user,
    password,
    migrationsDir
  };
}

export async function discoverMigrations(migrationsDir: string): Promise<DiscoveredMigration[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(migrationsDir);
  } catch (err) {
    throw new Error(`Failed to read migrations directory at ${migrationsDir}: ${String(err)}`);
  }

  const sqlFiles = entries.filter(e => e.endsWith('.sql'));
  const discovered: DiscoveredMigration[] = [];
  const seenIds = new Set<string>();

  for (const filename of sqlFiles) {
    const match = /^(\d{4})_[\w-]+\.sql$/.exec(filename);
    if (!match) {
      throw new MalformedMigrationIdentityError(
        `Invalid migration filename format '${filename}'. Expected '0001_name.sql'`
      );
    }

    const id = match[1];
    if (seenIds.has(id)) {
      throw new DuplicateMigrationIdentityError(
        `Duplicate migration ID '${id}' detected in file '${filename}'`
      );
    }
    seenIds.add(id);

    const fullPath = path.join(migrationsDir, filename);
    const content = await fs.readFile(fullPath, 'utf8');
    const checksum = computeChecksum(content);

    discovered.push({
      id,
      filename,
      fullPath,
      content,
      checksum
    });
  }

  discovered.sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));
  return discovered;
}

export async function runMigrations(customConfig: MigrationConfig = {}): Promise<MigrationResult> {
  const config = getResolvedConfig(customConfig);
  const discovered = await discoverMigrations(config.migrationsDir);

  const client = new pg.Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password
  });

  await client.connect();

  try {
    // Acquire PostgreSQL Advisory Lock to prevent concurrent execution
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_ID]);

    // Ensure migration history metadata table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS union_schema_migrations (
        migration_id VARCHAR(255) PRIMARY KEY,
        filename VARCHAR(255) NOT NULL,
        checksum VARCHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Fetch applied migrations
    const historyResult = await client.query<{
      migration_id: string;
      filename: string;
      checksum: string;
    }>('SELECT migration_id, filename, checksum FROM union_schema_migrations;');

    const appliedMap = new Map<string, { filename: string; checksum: string }>();
    for (const row of historyResult.rows) {
      appliedMap.set(row.migration_id, {
        filename: row.filename,
        checksum: row.checksum
      });
    }

    let appliedCount = 0;
    let alreadyAppliedCount = 0;
    const appliedList: string[] = [];

    for (const migration of discovered) {
      const existing = appliedMap.get(migration.id);

      if (existing) {
        if (existing.checksum !== migration.checksum) {
          throw new ChecksumMismatchError(
            `Checksum mismatch for applied migration '${migration.filename}' (ID: ${migration.id}). ` +
            `Stored checksum: ${existing.checksum}, Computed checksum: ${migration.checksum}`
          );
        }
        alreadyAppliedCount++;
      } else {
        // Apply migration atomically within a transaction
        await client.query('BEGIN');
        try {
          await client.query(migration.content);
          await client.query(
            `INSERT INTO union_schema_migrations (migration_id, filename, checksum, applied_at)
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
            [migration.id, migration.filename, migration.checksum]
          );
          await client.query('COMMIT');
          appliedCount++;
          appliedList.push(migration.filename);
        } catch (execError) {
          await client.query('ROLLBACK');
          throw execError;
        }
      }
    }

    return {
      appliedCount,
      alreadyAppliedCount,
      migrations: appliedList
    };
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]);
    } catch {
      // Ignore unlock errors during teardown if client disconnected
    }
    await client.end();
  }
}
