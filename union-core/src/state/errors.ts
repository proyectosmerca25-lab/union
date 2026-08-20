export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainError';
  }
}

export class NotFoundError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class InvalidStateTransitionError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStateTransitionError';
  }
}

export class InvalidInputError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInputError';
  }
}

export class CrossProjectViolationError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = 'CrossProjectViolationError';
  }
}

export class FrozenDecisionMutationError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = 'FrozenDecisionMutationError';
  }
}

export class AlreadyClosedError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = 'AlreadyClosedError';
  }
}

export class DatabaseFailureError extends DomainError {
  constructor(message: string, public readonly originalError?: unknown) {
    super(message);
    this.name = 'DatabaseFailureError';
  }
}
