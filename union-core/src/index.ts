import url from 'node:url';
import { bootstrapCore, CoreRuntimeHandle, CoreRuntimeIdentity } from './app/bootstrap.js';
import { CoreLifecycle, InvalidLifecycleTransitionError, LifecycleState } from './app/lifecycle.js';
import {
  getSafeConfigSummary,
  InvalidConfigurationError,
  loadConfig,
  MissingConfigurationError,
  SafeConfigSummary,
  UnionConfig,
  UnionEnv
} from './config/config.js';
import {
  ChecksumMismatchError,
  computeChecksum,
  discoverMigrations,
  DuplicateMigrationIdentityError,
  getResolvedConfig,
  MalformedMigrationIdentityError,
  MigrationConfig,
  MigrationResult,
  MissingDatabaseConfigurationError,
  runMigrations
} from './db/migrations/runner.js';
import {
  createLogger,
  FormattedLogEvent,
  Logger,
  LogLevel,
  LogOptions,
  SafeSerializedError,
  sanitizeContext,
  sanitizeError,
  sanitizeString
} from './logging/logger.js';
import { getSystemBaseline, SystemContract } from '@union/shared';

export {
  CoreLifecycle,
  InvalidLifecycleTransitionError,
  LifecycleState,
  bootstrapCore,
  CoreRuntimeHandle,
  CoreRuntimeIdentity,
  loadConfig,
  getSafeConfigSummary,
  UnionConfig,
  UnionEnv,
  SafeConfigSummary,
  MissingConfigurationError,
  InvalidConfigurationError,
  runMigrations,
  computeChecksum,
  discoverMigrations,
  getResolvedConfig,
  MigrationConfig,
  MigrationResult,
  MissingDatabaseConfigurationError,
  MalformedMigrationIdentityError,
  DuplicateMigrationIdentityError,
  ChecksumMismatchError,
  createLogger,
  Logger,
  LogLevel,
  FormattedLogEvent,
  LogOptions,
  SafeSerializedError,
  sanitizeString,
  sanitizeContext,
  sanitizeError
};

export interface CoreStatus {
  service: string;
  initialized: boolean;
  baseline: SystemContract;
}

export function getCoreStatus(): CoreStatus {
  return {
    service: '@union/core',
    initialized: true,
    baseline: getSystemBaseline()
  };
}

// Standalone process execution entry point check
const isMainModule = (): boolean => {
  if (!process.argv[1]) return false;
  try {
    const mainPath = url.fileURLToPath(import.meta.url);
    return process.argv[1] === mainPath;
  } catch {
    return false;
  }
};

if (isMainModule()) {
  void (async () => {
    const logger = createLogger('core-bootstrap', { env: process.env.UNION_ENV as UnionEnv });
    logger.info('CORE_STARTED', { message: 'Starting @union/core runtime skeleton...' });
    const handle = await bootstrapCore({ attachSignalListeners: true });
    logger.info('CORE_RUNNING', {
      message: 'Runtime started',
      context: {
        service: handle.identity.service,
        version: handle.identity.version,
        lifecycle: handle.lifecycle.getState()
      }
    });
  })();
}
