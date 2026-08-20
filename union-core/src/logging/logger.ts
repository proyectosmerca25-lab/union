import { UnionEnv } from '../config/config.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface SafeSerializedError {
  name: string;
  message: string;
  code?: string;
  stack?: string;
}

export interface FormattedLogEvent {
  timestamp: string;
  level: LogLevel;
  event: string;
  component: string;
  message?: string;
  error?: SafeSerializedError;
  context?: Record<string, string | number | boolean>;
  traceId?: string;
}

export interface LogOptions {
  message?: string;
  error?: unknown;
  context?: Record<string, unknown>;
  traceId?: string;
}

export type OutputHandler = (level: LogLevel, jsonLine: string, event: FormattedLogEvent) => void;

// Sensitive string patterns to automatically redact
const SENSITIVE_PATTERNS: RegExp[] = [
  /postgresql:\/\/[^@]+@/gi,
  /(?:password|secret|token|api_key|apikey|bearer)\s*[:=]\s*[^\s,;]+/gi
];

export function sanitizeString(input: string, customSecrets: string[] = []): string {
  if (!input) return input;
  let sanitized = input;

  // Redact known explicit secret values first
  for (const secret of customSecrets) {
    if (secret && secret.trim() !== '') {
      sanitized = sanitized.split(secret).join('[REDACTED_SECRET]');
    }
  }

  // Redact common sensitive pattern formats
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match) => {
      if (match.toLowerCase().startsWith('postgresql://')) {
        return 'postgresql://[REDACTED_SECRET]@';
      }
      const parts = match.split(/[:=]/);
      return `${parts[0]}: [REDACTED_SECRET]`;
    });
  }

  return sanitized;
}

export function sanitizeContext(
  rawContext?: Record<string, unknown>,
  customSecrets: string[] = []
): Record<string, string | number | boolean> | undefined {
  if (!rawContext || typeof rawContext !== 'object') {
    return undefined;
  }

  const result: Record<string, string | number | boolean> = {};
  let hasProperties = false;

  for (const [key, val] of Object.entries(rawContext)) {
    // POSITIVE ALLOW-LIST: accept only primitive string, number, boolean
    if (typeof val === 'string') {
      result[key] = sanitizeString(val, customSecrets);
      hasProperties = true;
    } else if (typeof val === 'number' || typeof val === 'boolean') {
      result[key] = val;
      hasProperties = true;
    }
    // Functions, objects, arrays, symbols, null, undefined are explicitly REJECTED/OMITTED
  }

  return hasProperties ? Object.freeze(result) : undefined;
}

export function sanitizeError(
  err: unknown,
  env: UnionEnv = 'production',
  customSecrets: string[] = []
): SafeSerializedError | undefined {
  if (!err) return undefined;

  let name = 'Error';
  let rawMessage = 'An unknown error occurred';
  let code: string | undefined;
  let rawStack: string | undefined;

  if (err instanceof Error) {
    name = err.name || 'Error';
    rawMessage = err.message || '';
    if (typeof (err as { code?: string }).code === 'string') {
      code = (err as { code?: string }).code;
    }
    rawStack = err.stack;
  } else if (typeof err === 'string') {
    rawMessage = err;
  }

  const message = sanitizeString(rawMessage, customSecrets);

  // Stack trace policy: MUST NOT expose stack in production environment by default
  const stack =
    env === 'production' || !rawStack ? undefined : sanitizeString(rawStack, customSecrets);

  return Object.freeze({
    name,
    message,
    ...(code !== undefined && { code }),
    ...(stack !== undefined && { stack })
  });
}

export class Logger {
  readonly component: string;
  readonly env: UnionEnv;
  readonly secretsToRedact: string[];
  private customOutputHandler?: OutputHandler;

  constructor(
    component: string,
    options: {
      env?: UnionEnv;
      secretsToRedact?: string[];
      outputHandler?: OutputHandler;
    } = {}
  ) {
    this.component = component;
    this.env = options.env ?? 'production';
    this.secretsToRedact = options.secretsToRedact ?? [];
    this.customOutputHandler = options.outputHandler;
  }

  private emit(level: LogLevel, eventName: string, logOptions?: LogOptions): FormattedLogEvent {
    const timestamp = new Date().toISOString();

    const formattedEvent: FormattedLogEvent = Object.freeze({
      timestamp,
      level,
      event: eventName,
      component: this.component,
      ...(logOptions?.message && {
        message: sanitizeString(logOptions.message, this.secretsToRedact)
      }),
      ...(logOptions?.error !== undefined && {
        error: sanitizeError(logOptions.error, this.env, this.secretsToRedact)
      }),
      ...(logOptions?.context && {
        context: sanitizeContext(logOptions.context, this.secretsToRedact)
      }),
      ...(logOptions?.traceId && {
        traceId: sanitizeString(logOptions.traceId, this.secretsToRedact)
      })
    });

    const jsonLine = JSON.stringify(formattedEvent) + '\n';

    if (this.customOutputHandler) {
      this.customOutputHandler(level, jsonLine, formattedEvent);
    } else {
      if (level === 'debug' || level === 'info') {
        process.stdout.write(jsonLine);
      } else {
        process.stderr.write(jsonLine);
      }
    }

    return formattedEvent;
  }

  debug(event: string, options?: LogOptions): FormattedLogEvent {
    return this.emit('debug', event, options);
  }

  info(event: string, options?: LogOptions): FormattedLogEvent {
    return this.emit('info', event, options);
  }

  warn(event: string, options?: LogOptions): FormattedLogEvent {
    return this.emit('warn', event, options);
  }

  error(event: string, options?: LogOptions): FormattedLogEvent {
    return this.emit('error', event, options);
  }
}

export function createLogger(
  component: string,
  options?: {
    env?: UnionEnv;
    secretsToRedact?: string[];
    outputHandler?: OutputHandler;
  }
): Logger {
  return new Logger(component, options);
}
