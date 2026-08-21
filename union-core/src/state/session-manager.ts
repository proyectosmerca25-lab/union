import pg from 'pg';
import { AuditContext, Session, SessionStatus } from './types.js';
import {
  AlreadyClosedError,
  DatabaseFailureError,
  DomainError,
  InvalidInputError,
  NotFoundError
} from './errors.js';
import { ProjectRegistry } from './project-registry.js';
import { AuditRecorder } from './audit-recorder.js';
import { CheckpointManager } from './checkpoint-manager.js';

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
  private readonly auditRecorder: AuditRecorder;

  constructor(private readonly client: pg.Client | pg.Pool) {
    this.projectRegistry = new ProjectRegistry(client);
    this.auditRecorder = new AuditRecorder(client);
  }

  private async getTxClient(): Promise<{ txClient: pg.ClientBase; shouldRelease: boolean }> {
    const isPool = 'totalCount' in this.client || 'idleCount' in this.client;
    if (isPool) {
      const txClient = await (this.client as pg.Pool).connect();
      return { txClient, shouldRelease: true };
    }
    return { txClient: this.client as pg.Client, shouldRelease: false };
  }

  private validateManagerAuditContext(auditContext: AuditContext): void {
    if (!auditContext) {
      throw new InvalidInputError('AuditContext is required for audited write operation');
    }
    if (auditContext.executedBy !== 'UNION_CORE') {
      throw new InvalidInputError(
        `Invalid executedBy: '${auditContext.executedBy}' must be 'UNION_CORE' for canonical manager operations`
      );
    }
  }

  async openSession(projectId: string, auditContext: AuditContext): Promise<Session> {
    if (!projectId || projectId.trim() === '') {
      throw new InvalidInputError('project_id is required');
    }
    this.validateManagerAuditContext(auditContext);

    const { txClient, shouldRelease } = await this.getTxClient();

    try {
      await txClient.query('BEGIN;');

      // Verify project exists in transaction
      await this.projectRegistry.getProject(projectId, txClient);

      const res = await txClient.query(
        `INSERT INTO sessions (project_id, status)
         VALUES ($1, 'OPEN')
         RETURNING session_id, project_id, status, started_at, closed_at, created_at, updated_at;`,
        [projectId]
      );
      const session = mapRowToSession(res.rows[0]);

      await this.auditRecorder.recordAuditEvent(
        {
          ...auditContext,
          projectId: session.projectId,
          sessionId: session.sessionId,
          action: 'SESSION_OPENED',
          result: 'SUCCESS'
        },
        txClient
      );

      await txClient.query('COMMIT;');
      return session;
    } catch (err: unknown) {
      await txClient.query('ROLLBACK;').catch(() => {});
      if (err instanceof DomainError) throw err;
      throw new DatabaseFailureError('Failed to open session for project');
    } finally {
      if (shouldRelease && 'release' in txClient) {
        (txClient as pg.PoolClient).release();
      }
    }
  }

  async getSession(sessionId: string, clientOverride?: pg.ClientBase): Promise<Session> {
    if (!sessionId || sessionId.trim() === '') {
      throw new InvalidInputError('session_id is required');
    }

    const targetClient = clientOverride || this.client;

    try {
      const res = await targetClient.query(
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
      throw new DatabaseFailureError('Failed to fetch session');
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
      throw new DatabaseFailureError('Failed to list sessions for project');
    }
  }

  async closeSession(sessionId: string, auditContext: AuditContext): Promise<Session> {
    if (!sessionId || sessionId.trim() === '') {
      throw new InvalidInputError('session_id is required');
    }
    this.validateManagerAuditContext(auditContext);

    const { txClient, shouldRelease } = await this.getTxClient();

    try {
      await txClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ;');

      const session = await this.getSession(sessionId, txClient);
      if (session.status === 'CLOSED') {
        throw new AlreadyClosedError(`Session '${sessionId}' is already CLOSED`);
      }

      // Create SESSION Checkpoint transactionally prior to session close
      const checkpointManager = new CheckpointManager(txClient as any);
      await checkpointManager.createCheckpoint(
        {
          projectId: session.projectId,
          checkpointType: 'SESSION',
          trigger: 'SESSION_CLOSE',
          sessionId: session.sessionId
        },
        auditContext,
        txClient
      );

      const res = await txClient.query(
        `UPDATE sessions
         SET status = 'CLOSED', closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE session_id = $1 AND status = 'OPEN'
         RETURNING session_id, project_id, status, started_at, closed_at, created_at, updated_at;`,
        [sessionId]
      );
      if (res.rows.length === 0) {
        throw new AlreadyClosedError(`Session '${sessionId}' is already CLOSED`);
      }
      const closedSession = mapRowToSession(res.rows[0]);

      await this.auditRecorder.recordAuditEvent(
        {
          ...auditContext,
          projectId: closedSession.projectId,
          sessionId: closedSession.sessionId,
          action: 'SESSION_CLOSED',
          result: 'SUCCESS'
        },
        txClient
      );

      await txClient.query('COMMIT;');
      return closedSession;
    } catch (err: unknown) {
      await txClient.query('ROLLBACK;').catch(() => {});
      if (err instanceof DomainError) throw err;
      throw new DatabaseFailureError('Failed to close session');
    } finally {
      if (shouldRelease && 'release' in txClient) {
        (txClient as pg.PoolClient).release();
      }
    }
  }
}
