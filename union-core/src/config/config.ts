export type UnionEnv = 'local' | 'test' | 'production';

export interface UnionConfig {
  readonly env: UnionEnv;
  readonly databaseUrl: string;
  readonly port: number;
}

export interface SafeConfigSummary {
  readonly environment: UnionEnv;
  readonly databaseConfigured: boolean;
}

export class MissingConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingConfigurationError';
  }
}

export class InvalidConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidConfigurationError';
  }
}

export function loadConfig(envSource?: Record<string, string | undefined>): UnionConfig {
  const envMap = envSource ?? process.env;

  const rawEnv = envMap.UNION_ENV;
  if (!rawEnv || rawEnv.trim() === '') {
    throw new MissingConfigurationError('Missing required configuration: UNION_ENV is required');
  }

  const trimmedEnv = rawEnv.trim();
  const validEnvs: UnionEnv[] = ['local', 'test', 'production'];
  if (!validEnvs.includes(trimmedEnv as UnionEnv)) {
    throw new InvalidConfigurationError(
      `Invalid configuration: UNION_ENV must be one of: local, test, production. Received: '${trimmedEnv}'`
    );
  }
  const env = trimmedEnv as UnionEnv;

  const rawDbUrl = envMap.DATABASE_URL;
  if (!rawDbUrl || rawDbUrl.trim() === '') {
    throw new MissingConfigurationError('Missing required configuration: DATABASE_URL is required');
  }
  const databaseUrl = rawDbUrl.trim();

  const rawPort = envMap.PORT;
  if (!rawPort || rawPort.trim() === '') {
    throw new MissingConfigurationError('Missing required configuration: PORT is required');
  }
  const trimmedPort = rawPort.trim();
  if (!/^\d+$/.test(trimmedPort)) {
    throw new InvalidConfigurationError('Invalid configuration: PORT must be a valid integer');
  }

  const port = parseInt(trimmedPort, 10);
  if (port < 1 || port > 65535) {
    throw new InvalidConfigurationError('Invalid configuration: PORT must be between 1 and 65535');
  }

  return Object.freeze({
    env,
    databaseUrl,
    port
  });
}

export function getSafeConfigSummary(config: UnionConfig): SafeConfigSummary {
  return Object.freeze({
    environment: config.env,
    databaseConfigured: Boolean(config.databaseUrl && config.databaseUrl.trim() !== '')
  });
}
