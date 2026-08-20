import pg from 'pg';
import {
  AuditContext,
  CreateProjectInput,
  Project,
  ProjectStatus
} from './types.js';
import {
  InvalidInputError,
  NotFoundError,
  DatabaseFailureError,
  DomainError
} from './errors.js';
import { AuditRecorder } from './audit-recorder.js';

function mapRowToProject(row: any): Project {
  return {
    projectId: row.project_id,
    displayName: row.display_name,
    status: row.status as ProjectStatus,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at)
  };
}

export class ProjectRegistry {
  private readonly auditRecorder: AuditRecorder;

  constructor(private readonly client: pg.Client | pg.Pool) {
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

  async createProject(input: CreateProjectInput, auditContext: AuditContext): Promise<Project> {
    if (!input || !input.displayName || input.displayName.trim() === '') {
      throw new InvalidInputError('Project display_name is required and cannot be empty');
    }
    if (!auditContext) {
      throw new InvalidInputError('AuditContext is required for audited write operation');
    }

    const { txClient, shouldRelease } = await this.getTxClient();

    try {
      await txClient.query('BEGIN;');

      const res = await txClient.query(
        `INSERT INTO projects (display_name, status)
         VALUES ($1, 'ACTIVE')
         RETURNING project_id, display_name, status, created_at, updated_at;`,
        [input.displayName.trim()]
      );
      const project = mapRowToProject(res.rows[0]);

      await this.auditRecorder.recordAuditEvent(
        {
          ...auditContext,
          projectId: project.projectId,
          action: 'PROJECT_CREATED',
          result: 'SUCCESS'
        },
        txClient
      );

      await txClient.query('COMMIT;');
      return project;
    } catch (err: unknown) {
      await txClient.query('ROLLBACK;').catch(() => {});
      if (err instanceof DomainError) throw err;
      throw new DatabaseFailureError('Failed to create project', err);
    } finally {
      if (shouldRelease && 'release' in txClient) {
        (txClient as pg.PoolClient).release();
      }
    }
  }

  async getProject(projectId: string, clientOverride?: pg.ClientBase): Promise<Project> {
    if (!projectId || projectId.trim() === '') {
      throw new InvalidInputError('project_id is required');
    }

    const targetClient = clientOverride || this.client;

    try {
      const res = await targetClient.query(
        `SELECT project_id, display_name, status, created_at, updated_at
         FROM projects
         WHERE project_id = $1;`,
        [projectId]
      );
      if (res.rows.length === 0) {
        throw new NotFoundError(`Project not found with project_id: '${projectId}'`);
      }
      return mapRowToProject(res.rows[0]);
    } catch (err: unknown) {
      if (err instanceof NotFoundError || err instanceof InvalidInputError) throw err;
      throw new DatabaseFailureError(`Failed to fetch project '${projectId}'`, err);
    }
  }

  async listProjects(): Promise<Project[]> {
    try {
      const res = await this.client.query(
        `SELECT project_id, display_name, status, created_at, updated_at
         FROM projects
         ORDER BY created_at ASC;`
      );
      return res.rows.map(mapRowToProject);
    } catch (err: unknown) {
      throw new DatabaseFailureError('Failed to list projects', err);
    }
  }

  async updateDisplayName(
    projectId: string,
    displayName: string,
    auditContext: AuditContext
  ): Promise<Project> {
    if (!projectId || projectId.trim() === '') {
      throw new InvalidInputError('project_id is required');
    }
    if (!displayName || displayName.trim() === '') {
      throw new InvalidInputError('display_name is required and cannot be empty');
    }
    if (!auditContext) {
      throw new InvalidInputError('AuditContext is required for audited write operation');
    }

    const { txClient, shouldRelease } = await this.getTxClient();

    try {
      await txClient.query('BEGIN;');

      const res = await txClient.query(
        `UPDATE projects
         SET display_name = $2, updated_at = CURRENT_TIMESTAMP
         WHERE project_id = $1
         RETURNING project_id, display_name, status, created_at, updated_at;`,
        [projectId, displayName.trim()]
      );

      if (res.rows.length === 0) {
        throw new NotFoundError(`Project not found with project_id: '${projectId}'`);
      }
      const project = mapRowToProject(res.rows[0]);

      await this.auditRecorder.recordAuditEvent(
        {
          ...auditContext,
          projectId: project.projectId,
          action: 'PROJECT_RENAMED',
          result: 'SUCCESS'
        },
        txClient
      );

      await txClient.query('COMMIT;');
      return project;
    } catch (err: unknown) {
      await txClient.query('ROLLBACK;').catch(() => {});
      if (err instanceof DomainError) throw err;
      throw new DatabaseFailureError(`Failed to update display_name for project '${projectId}'`, err);
    } finally {
      if (shouldRelease && 'release' in txClient) {
        (txClient as pg.PoolClient).release();
      }
    }
  }

  async changeProjectStatus(
    projectId: string,
    status: ProjectStatus,
    auditContext: AuditContext
  ): Promise<Project> {
    if (!projectId || projectId.trim() === '') {
      throw new InvalidInputError('project_id is required');
    }
    const validStatuses: ProjectStatus[] = ['ACTIVE', 'PAUSED', 'ARCHIVED'];
    if (!status || !validStatuses.includes(status)) {
      throw new InvalidInputError(
        `Invalid project status: '${status}'. Must be one of: ACTIVE, PAUSED, ARCHIVED`
      );
    }
    if (!auditContext) {
      throw new InvalidInputError('AuditContext is required for audited write operation');
    }

    const { txClient, shouldRelease } = await this.getTxClient();

    try {
      await txClient.query('BEGIN;');

      const res = await txClient.query(
        `UPDATE projects
         SET status = $2, updated_at = CURRENT_TIMESTAMP
         WHERE project_id = $1
         RETURNING project_id, display_name, status, created_at, updated_at;`,
        [projectId, status]
      );

      if (res.rows.length === 0) {
        throw new NotFoundError(`Project not found with project_id: '${projectId}'`);
      }
      const project = mapRowToProject(res.rows[0]);

      await this.auditRecorder.recordAuditEvent(
        {
          ...auditContext,
          projectId: project.projectId,
          action: 'PROJECT_STATUS_CHANGED',
          result: 'SUCCESS'
        },
        txClient
      );

      await txClient.query('COMMIT;');
      return project;
    } catch (err: unknown) {
      await txClient.query('ROLLBACK;').catch(() => {});
      if (err instanceof DomainError) throw err;
      throw new DatabaseFailureError(`Failed to change status for project '${projectId}'`, err);
    } finally {
      if (shouldRelease && 'release' in txClient) {
        (txClient as pg.PoolClient).release();
      }
    }
  }
}
