import pg from 'pg';
import { Session, SessionStatus } from './types.js';
import {
  AlreadyClosedError,
  DatabaseFailureError,
  InvalidInputError,
  NotFoundError
} from './errors.js';
import { ProjectRegistry } from './project-registry.js';

function mapRowToSession(row: any): Session {
  return {
    sessionId: row.session_id,
    projectId: row.project_id,
    status: row.status as SessionStatus,
    startedAt: new Date(row.started_at),
    closedAt: row.closed_at ? new Date(row.closed_at) : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at)
  };
}

export class SessionManager {
  private readonly projectRegistry: ProjectRegistry;

  constructor(private readonly client: pg.Client | pg.Pool) {
    this.projectRegistry = new ProjectRegistry(client);
  }

  async openSession(projectId: string): Promise<Session> {
    if (!projectId || projectId.trim() === '') {
      throw new InvalidInputError('project_id is required');
    }

    // Verify project exists
    await this.projectRegistry.getProject(projectId);

    try {
      const res = await this.client.query(
        `INSERT INTO sessions (project_id, status)
         VALUES ($1, 'OPEN')
         RETURNING session_id, project_id, status, started_at, closed_at, created_at, updated_at;`,
        [projectId]
      );
      return mapRowToSession(res.rows[0]);
    } catch (err: unknown) {
      if (err instanceof NotFoundError || err instanceof InvalidInputError) throw err;
      throw new DatabaseFailureError(`Failed to open session for project '${projectId}'`, err);
    }
  }

  async getSession(sessionId: string): Promise<Session> {
    if (!sessionId || sessionId.trim() === '') {
      throw new InvalidInputError('session_id is required');
    }

    try {
      const res = await this.client.query(
        `SELECT session_id, project_id, status, started_at, closed_at, created_at, updated_at
         FROM sessions
         WHERE session_id = $1;`,
        [sessionId]
      );
      if (res.rows.length === 0) {
        throw new NotFoundError(`Session not found with session_id: '${sessionId}'`);
      }
      return mapRowToSession(res.rows[0]);
    } catch (err: unknown) {
      if (err instanceof NotFoundError || err instanceof InvalidInputError) throw err;
      throw new DatabaseFailureError(`Failed to fetch session '${sessionId}'`, err);
    }
  }

  async listProjectSessions(projectId: string): Promise<Session[]> {
    if (!projectId || projectId.trim() === '') {
      throw new InvalidInputError('project_id is required');
    }

    // Verify project exists
    await this.projectRegistry.getProject(projectId);

    try {
      const res = await this.client.query(
        `SELECT session_id, project_id, status, started_at, closed_at, created_at, updated_at
         FROM sessions
         WHERE project_id = $1
         ORDER BY started_at ASC;`,
        [projectId]
      );
      return res.rows.map(mapRowToSession);
    } catch (err: unknown) {
      if (err instanceof NotFoundError || err instanceof InvalidInputError) throw err;
      throw new DatabaseFailureError(`Failed to list sessions for project '${projectId}'`, err);
    }
  }

  async closeSession(sessionId: string): Promise<Session> {
    if (!sessionId || sessionId.trim() === '') {
      throw new InvalidInputError('session_id is required');
    }

    const session = await this.getSession(sessionId);
    if (session.status === 'CLOSED') {
      throw new AlreadyClosedError(`Session '${sessionId}' is already CLOSED`);
    }

    try {
      const res = await this.client.query(
        `UPDATE sessions
         SET status = 'CLOSED', closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE session_id = $1 AND status = 'OPEN'
         RETURNING session_id, project_id, status, started_at, closed_at, created_at, updated_at;`,
        [sessionId]
      );
      if (res.rows.length === 0) {
        throw new AlreadyClosedError(`Session '${sessionId}' is already CLOSED`);
      }
      return mapRowToSession(res.rows[0]);
    } catch (err: unknown) {
      if (err instanceof AlreadyClosedError || err instanceof NotFoundError || err instanceof InvalidInputError) {
        throw err;
      }
      throw new DatabaseFailureError(`Failed to close session '${sessionId}'`, err);
    }
  }
}
