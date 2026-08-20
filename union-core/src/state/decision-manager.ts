import pg from 'pg';
import {
  CreateDecisionInput,
  Decision,
  DecisionStatus,
  SupersedeDecisionInput,
  UpdateDecisionContentInput
} from './types.js';
import {
  CrossProjectViolationError,
  DatabaseFailureError,
  DomainError,
  FrozenDecisionMutationError,
  InvalidInputError,
  InvalidStateTransitionError,
  NotFoundError
} from './errors.js';
import { ProjectRegistry } from './project-registry.js';
import { SessionManager } from './session-manager.js';

function mapRowToDecision(row: any): Decision {
  let altConsidered: unknown[] | null = null;
  if (row.alternatives_considered !== null && row.alternatives_considered !== undefined) {
    altConsidered = typeof row.alternatives_considered === 'string'
      ? JSON.parse(row.alternatives_considered)
      : row.alternatives_considered;
  }

  return {
    decisionId: row.decision_id,
    projectId: row.project_id,
    sessionId: row.session_id || null,
    topic: row.topic,
    decision: row.decision,
    status: row.status as DecisionStatus,
    reason: row.reason || null,
    alternativesConsidered: altConsidered,
    authority: row.authority,
    supersedesDecisionId: row.supersedes_decision_id || null,
    reopenCondition: row.reopen_condition || null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    decidedAt: row.decided_at ? new Date(row.decided_at) : null
  };
}

export class DecisionManager {
  private readonly projectRegistry: ProjectRegistry;
  private readonly sessionManager: SessionManager;

  constructor(private readonly client: pg.Client | pg.Pool) {
    this.projectRegistry = new ProjectRegistry(client);
    this.sessionManager = new SessionManager(client);
  }

  async createDecision(input: CreateDecisionInput): Promise<Decision> {
    if (!input || !input.projectId || input.projectId.trim() === '') {
      throw new InvalidInputError('project_id is required');
    }
    if (!input.topic || input.topic.trim() === '') {
      throw new InvalidInputError('topic is required and cannot be empty');
    }
    if (!input.decision || input.decision.trim() === '') {
      throw new InvalidInputError('decision is required and cannot be empty');
    }
    if (!input.reason || input.reason.trim() === '') {
      throw new InvalidInputError('reason is required and cannot be empty');
    }
    if (!input.authority || input.authority.trim() === '') {
      throw new InvalidInputError('authority is required and cannot be empty');
    }

    // Verify project exists
    await this.projectRegistry.getProject(input.projectId);

    // If session_id provided, verify session exists and belongs to same project
    if (input.sessionId) {
      const session = await this.sessionManager.getSession(input.sessionId);
      if (session.projectId !== input.projectId) {
        throw new CrossProjectViolationError(
          `Cross-project isolation violation: Session '${input.sessionId}' belongs to project '${session.projectId}', not '${input.projectId}'`
        );
      }
    }

    const altJson = input.alternativesConsidered ? JSON.stringify(input.alternativesConsidered) : null;

    try {
      const res = await this.client.query(
        `INSERT INTO decisions (
           project_id, session_id, topic, decision, status, reason, alternatives_considered, authority
         )
         VALUES ($1, $2, $3, $4, 'PROPOSED', $5, $6, $7)
         RETURNING *;`,
        [
          input.projectId,
          input.sessionId || null,
          input.topic.trim(),
          input.decision.trim(),
          input.reason ? input.reason.trim() : null,
          altJson,
          input.authority.trim()
        ]
      );
      return mapRowToDecision(res.rows[0]);
    } catch (err: unknown) {
      if (err instanceof NotFoundError || err instanceof InvalidInputError || err instanceof CrossProjectViolationError) {
        throw err;
      }
      throw new DatabaseFailureError('Failed to create decision', err);
    }
  }

  async getDecision(decisionId: string): Promise<Decision> {
    if (!decisionId || decisionId.trim() === '') {
      throw new InvalidInputError('decision_id is required');
    }

    try {
      const res = await this.client.query(
        `SELECT * FROM decisions WHERE decision_id = $1;`,
        [decisionId]
      );
      if (res.rows.length === 0) {
        throw new NotFoundError(`Decision not found with decision_id: '${decisionId}'`);
      }
      return mapRowToDecision(res.rows[0]);
    } catch (err: unknown) {
      if (err instanceof NotFoundError || err instanceof InvalidInputError) throw err;
      throw new DatabaseFailureError(`Failed to fetch decision '${decisionId}'`, err);
    }
  }

  async listProjectDecisions(projectId: string): Promise<Decision[]> {
    if (!projectId || projectId.trim() === '') {
      throw new InvalidInputError('project_id is required');
    }

    // Verify project exists
    await this.projectRegistry.getProject(projectId);

    try {
      const res = await this.client.query(
        `SELECT * FROM decisions WHERE project_id = $1 ORDER BY created_at ASC;`,
        [projectId]
      );
      return res.rows.map(mapRowToDecision);
    } catch (err: unknown) {
      if (err instanceof NotFoundError || err instanceof InvalidInputError) throw err;
      throw new DatabaseFailureError(`Failed to list decisions for project '${projectId}'`, err);
    }
  }

  async approveDecision(decisionId: string): Promise<Decision> {
    if (!decisionId || decisionId.trim() === '') {
      throw new InvalidInputError('decision_id is required');
    }

    try {
      const res = await this.client.query(
        `UPDATE decisions
         SET status = 'APPROVED', decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE decision_id = $1 AND status IN ('PROPOSED', 'REOPENED')
         RETURNING *;`,
        [decisionId]
      );
      if (res.rows.length > 0) {
        return mapRowToDecision(res.rows[0]);
      }
    } catch (err: unknown) {
      if (err instanceof DomainError) throw err;
      throw new DatabaseFailureError(`Failed to approve decision '${decisionId}'`, err);
    }

    const current = await this.getDecision(decisionId);
    throw new InvalidStateTransitionError(
      `Invalid state transition: Cannot approve decision in '${current.status}' state`
    );
  }

  async freezeDecision(decisionId: string): Promise<Decision> {
    if (!decisionId || decisionId.trim() === '') {
      throw new InvalidInputError('decision_id is required');
    }

    try {
      const res = await this.client.query(
        `UPDATE decisions
         SET status = 'FROZEN', updated_at = CURRENT_TIMESTAMP
         WHERE decision_id = $1 AND status = 'APPROVED'
         RETURNING *;`,
        [decisionId]
      );
      if (res.rows.length > 0) {
        return mapRowToDecision(res.rows[0]);
      }
    } catch (err: unknown) {
      if (err instanceof DomainError) throw err;
      throw new DatabaseFailureError(`Failed to freeze decision '${decisionId}'`, err);
    }

    const current = await this.getDecision(decisionId);
    throw new InvalidStateTransitionError(
      `Invalid state transition: Cannot freeze decision in '${current.status}' state`
    );
  }

  async rejectDecision(decisionId: string): Promise<Decision> {
    if (!decisionId || decisionId.trim() === '') {
      throw new InvalidInputError('decision_id is required');
    }

    try {
      const res = await this.client.query(
        `UPDATE decisions
         SET status = 'REJECTED', decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE decision_id = $1 AND status IN ('PROPOSED', 'REOPENED')
         RETURNING *;`,
        [decisionId]
      );
      if (res.rows.length > 0) {
        return mapRowToDecision(res.rows[0]);
      }
    } catch (err: unknown) {
      if (err instanceof DomainError) throw err;
      throw new DatabaseFailureError(`Failed to reject decision '${decisionId}'`, err);
    }

    const current = await this.getDecision(decisionId);
    throw new InvalidStateTransitionError(
      `Invalid state transition: Cannot reject decision in '${current.status}' state`
    );
  }

  async reopenDecision(decisionId: string, reopenCondition?: string | null): Promise<Decision> {
    if (!decisionId || decisionId.trim() === '') {
      throw new InvalidInputError('decision_id is required');
    }

    try {
      const res = await this.client.query(
        `UPDATE decisions
         SET status = 'REOPENED', reopen_condition = $2, updated_at = CURRENT_TIMESTAMP
         WHERE decision_id = $1 AND status = 'FROZEN'
         RETURNING *;`,
        [decisionId, reopenCondition ? reopenCondition.trim() : null]
      );
      if (res.rows.length > 0) {
        return mapRowToDecision(res.rows[0]);
      }
    } catch (err: unknown) {
      if (err instanceof DomainError) throw err;
      throw new DatabaseFailureError(`Failed to reopen decision '${decisionId}'`, err);
    }

    const current = await this.getDecision(decisionId);
    throw new InvalidStateTransitionError(
      `Invalid state transition: Cannot reopen decision in '${current.status}' state`
    );
  }

  async updateDecisionContent(
    decisionId: string,
    content: UpdateDecisionContentInput
  ): Promise<Decision> {
    if (!decisionId || decisionId.trim() === '') {
      throw new InvalidInputError('decision_id is required');
    }

    const current = await this.getDecision(decisionId);

    const newTopic = content.topic !== undefined ? content.topic.trim() : current.topic;
    const newDecision = content.decision !== undefined ? content.decision.trim() : current.decision;
    const newReason = content.reason !== undefined ? (content.reason ? content.reason.trim() : null) : current.reason;
    const newAuthority = content.authority !== undefined ? content.authority.trim() : current.authority;
    const newAlt = content.alternativesConsidered !== undefined
      ? (content.alternativesConsidered ? JSON.stringify(content.alternativesConsidered) : null)
      : (current.alternativesConsidered ? JSON.stringify(current.alternativesConsidered) : null);

    if (!newTopic) throw new InvalidInputError('topic cannot be empty');
    if (!newDecision) throw new InvalidInputError('decision cannot be empty');
    if (!newAuthority) throw new InvalidInputError('authority cannot be empty');

    try {
      const res = await this.client.query(
        `UPDATE decisions
         SET topic = $2, decision = $3, reason = $4, alternatives_considered = $5, authority = $6, updated_at = CURRENT_TIMESTAMP
         WHERE decision_id = $1 AND status IN ('PROPOSED', 'REOPENED')
         RETURNING *;`,
        [decisionId, newTopic, newDecision, newReason, newAlt, newAuthority]
      );
      if (res.rows.length > 0) {
        return mapRowToDecision(res.rows[0]);
      }
    } catch (err: unknown) {
      if (err instanceof DomainError) throw err;
      throw new DatabaseFailureError(`Failed to update decision content for '${decisionId}'`, err);
    }

    const latest = await this.getDecision(decisionId);
    if (latest.status === 'FROZEN') {
      throw new FrozenDecisionMutationError(
        `Frozen decision mutation denied: Decision '${decisionId}' is FROZEN and cannot be modified directly`
      );
    }
    throw new InvalidStateTransitionError(
      `Cannot update content of decision in '${latest.status}' state`
    );
  }

  async supersedeDecision(
    input: SupersedeDecisionInput
  ): Promise<{ predecessor: Decision; successor: Decision }> {
    if (!input || !input.predecessorDecisionId || input.predecessorDecisionId.trim() === '') {
      throw new InvalidInputError('predecessorDecisionId is required');
    }

    const isPool = 'totalCount' in this.client || 'idleCount' in this.client;
    let txClient: pg.ClientBase;
    let shouldRelease = false;

    if (isPool) {
      txClient = await (this.client as pg.Pool).connect();
      shouldRelease = true;
    } else {
      txClient = this.client as pg.Client;
    }

    try {
      await txClient.query('BEGIN;');

      const predSelRes = await txClient.query(
        `SELECT * FROM decisions WHERE decision_id = $1 FOR UPDATE;`,
        [input.predecessorDecisionId]
      );

      if (predSelRes.rows.length === 0) {
        throw new NotFoundError(`Decision not found with decision_id: '${input.predecessorDecisionId}'`);
      }

      const predecessor = mapRowToDecision(predSelRes.rows[0]);

      if (predecessor.status !== 'FROZEN' && predecessor.status !== 'REOPENED') {
        throw new InvalidStateTransitionError(
          `Invalid state transition: Cannot supersede decision in '${predecessor.status}' state`
        );
      }

      if (input.sessionId) {
        const sessionRes = await txClient.query(
          `SELECT project_id FROM sessions WHERE session_id = $1;`,
          [input.sessionId]
        );
        if (sessionRes.rows.length === 0) {
          throw new NotFoundError(`Session not found with session_id: '${input.sessionId}'`);
        }
        if (sessionRes.rows[0].project_id !== predecessor.projectId) {
          throw new CrossProjectViolationError(
            `Cross-project isolation violation: Session '${input.sessionId}' belongs to project '${sessionRes.rows[0].project_id}', not '${predecessor.projectId}'`
          );
        }
      }

      const altJson = input.alternativesConsidered ? JSON.stringify(input.alternativesConsidered) : null;

      const succRes = await txClient.query(
        `INSERT INTO decisions (
           project_id, session_id, topic, decision, status, reason, alternatives_considered, authority, supersedes_decision_id
         )
         VALUES ($1, $2, $3, $4, 'PROPOSED', $5, $6, $7, $8)
         RETURNING *;`,
        [
          predecessor.projectId,
          input.sessionId || null,
          input.topic.trim(),
          input.decision.trim(),
          input.reason ? input.reason.trim() : predecessor.reason,
          altJson,
          input.authority.trim(),
          predecessor.decisionId
        ]
      );
      const successor = mapRowToDecision(succRes.rows[0]);

      const predRes = await txClient.query(
        `UPDATE decisions
         SET status = 'SUPERSEDED', updated_at = CURRENT_TIMESTAMP
         WHERE decision_id = $1 AND status IN ('FROZEN', 'REOPENED')
         RETURNING *;`,
        [predecessor.decisionId]
      );

      if (predRes.rows.length === 0) {
        throw new InvalidStateTransitionError(
          `Invalid state transition: Cannot supersede decision in '${predecessor.status}' state`
        );
      }

      const updatedPredecessor = mapRowToDecision(predRes.rows[0]);

      await txClient.query('COMMIT;');

      return { predecessor: updatedPredecessor, successor };
    } catch (err: unknown) {
      await txClient.query('ROLLBACK;').catch(() => {});
      if (err instanceof DomainError) throw err;
      throw new DatabaseFailureError(`Failed to supersede decision '${input.predecessorDecisionId}'`, err);
    } finally {
      if (shouldRelease && 'release' in txClient) {
        (txClient as pg.PoolClient).release();
      }
    }
  }
}
