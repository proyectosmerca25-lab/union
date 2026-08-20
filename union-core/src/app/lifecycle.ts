export type LifecycleState = 'CREATED' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'STOPPED';

export class InvalidLifecycleTransitionError extends Error {
  constructor(public readonly currentState: LifecycleState, public readonly targetState: LifecycleState) {
    super(`Invalid lifecycle transition from ${currentState} to ${targetState}`);
    this.name = 'InvalidLifecycleTransitionError';
  }
}

export type CleanupHandler = () => Promise<void> | void;

export class CoreLifecycle {
  private state: LifecycleState = 'CREATED';
  private readonly history: LifecycleState[] = ['CREATED'];
  private readonly cleanupHandlers: CleanupHandler[] = [];

  public getState(): LifecycleState {
    return this.state;
  }

  public getHistory(): readonly LifecycleState[] {
    return [...this.history];
  }

  public onCleanup(handler: CleanupHandler): void {
    this.cleanupHandlers.push(handler);
  }

  public async start(): Promise<void> {
    if (this.state !== 'CREATED') {
      throw new InvalidLifecycleTransitionError(this.state, 'STARTING');
    }

    this.transitionTo('STARTING');

    // Startup steps boundary (extendable in future phases)

    this.transitionTo('RUNNING');
  }

  public async stop(): Promise<void> {
    if (this.state === 'STOPPED') {
      // Idempotent: repeated stop on already STOPPED instance returns safely
      return;
    }

    if (this.state !== 'RUNNING' && this.state !== 'STOPPING') {
      throw new InvalidLifecycleTransitionError(this.state, 'STOPPING');
    }

    if (this.state !== 'STOPPING') {
      this.transitionTo('STOPPING');
    }

    for (const handler of this.cleanupHandlers) {
      await handler();
    }

    this.transitionTo('STOPPED');
  }

  private transitionTo(nextState: LifecycleState): void {
    this.validateTransition(this.state, nextState);
    this.state = nextState;
    this.history.push(nextState);
  }

  private validateTransition(current: LifecycleState, next: LifecycleState): void {
    const validTransitions: Record<LifecycleState, LifecycleState[]> = {
      CREATED: ['STARTING'],
      STARTING: ['RUNNING'],
      RUNNING: ['STOPPING'],
      STOPPING: ['STOPPED'],
      STOPPED: []
    };

    const allowed = validTransitions[current];
    if (!allowed || !allowed.includes(next)) {
      throw new InvalidLifecycleTransitionError(current, next);
    }
  }
}
