import pg from 'pg';
import {
  CreateProjectInput,
  Project,
  ProjectStatus
} from './types.js';
import {
  InvalidInputError,
  NotFoundError,
  DatabaseFailureError
} from './errors.js';

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
  constructor(private readonly client: pg.Client | pg.Pool) {}

  async createProject(input: CreateProjectInput): Promise<Project> {
    if (!input || !input.displayName || input.displayName.trim() === '') {
      throw new InvalidInputError('Project display_name is required and cannot be empty');
    }

    try {
      const res = await this.client.query(
        `INSERT INTO projects (display_name, status)
         VALUES ($1, 'ACTIVE')
         RETURNING project_id, display_name, status, created_at, updated_at;`,
        [input.displayName.trim()]
      );
      return mapRowToProject(res.rows[0]);
    } catch (err: unknown) {
      if (err instanceof InvalidInputError) throw err;
      throw new DatabaseFailureError('Failed to create project', err);
    }
  }

  async getProject(projectId: string): Promise<Project> {
    if (!projectId || projectId.trim() === '') {
      throw new InvalidInputError('project_id is required');
    }

    try {
      const res = await this.client.query(
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

  async updateDisplayName(projectId: string, displayName: string): Promise<Project> {
    if (!projectId || projectId.trim() === '') {
      throw new InvalidInputError('project_id is required');
    }
    if (!displayName || displayName.trim() === '') {
      throw new InvalidInputError('display_name is required and cannot be empty');
    }

    try {
      const res = await this.client.query(
        `UPDATE projects
         SET display_name = $2, updated_at = CURRENT_TIMESTAMP
         WHERE project_id = $1
         RETURNING project_id, display_name, status, created_at, updated_at;`,
        [projectId, displayName.trim()]
      );
      if (res.rows.length === 0) {
        throw new NotFoundError(`Project not found with project_id: '${projectId}'`);
      }
      return mapRowToProject(res.rows[0]);
    } catch (err: unknown) {
      if (err instanceof NotFoundError || err instanceof InvalidInputError) throw err;
      throw new DatabaseFailureError(`Failed to update display_name for project '${projectId}'`, err);
    }
  }

  async changeProjectStatus(projectId: string, status: ProjectStatus): Promise<Project> {
    if (!projectId || projectId.trim() === '') {
      throw new InvalidInputError('project_id is required');
    }

    const validStatuses: ProjectStatus[] = ['ACTIVE', 'PAUSED', 'ARCHIVED'];
    if (!status || !validStatuses.includes(status)) {
      throw new InvalidInputError(
        `Invalid project status: '${status}'. Must be one of: ACTIVE, PAUSED, ARCHIVED`
      );
    }

    try {
      const res = await this.client.query(
        `UPDATE projects
         SET status = $2, updated_at = CURRENT_TIMESTAMP
         WHERE project_id = $1
         RETURNING project_id, display_name, status, created_at, updated_at;`,
        [projectId, status]
      );
      if (res.rows.length === 0) {
        throw new NotFoundError(`Project not found with project_id: '${projectId}'`);
      }
      return mapRowToProject(res.rows[0]);
    } catch (err: unknown) {
      if (err instanceof NotFoundError || err instanceof InvalidInputError) throw err;
      throw new DatabaseFailureError(`Failed to change status for project '${projectId}'`, err);
    }
  }
}
