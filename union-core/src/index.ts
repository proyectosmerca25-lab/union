import url from 'node:url';
import { bootstrapCore, CoreRuntimeHandle, CoreRuntimeIdentity } from './app/bootstrap.js';
import { CoreLifecycle, InvalidLifecycleTransitionError, LifecycleState } from './app/lifecycle.js';
import {
  EnvironmentMismatchError,
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
  createHttpServer,
  HttpServerHandle,
  HttpServerOptions
} from './http/server.js';
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
  EnvironmentMismatchError,
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
  sanitizeError,
  createHttpServer,
  HttpServerHandle,
  HttpServerOptions
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
    try {
      const config = loadConfig();
      const logger = createLogger('core-bootstrap', { env: config.env });
      logger.info('CORE_STARTED', { message: 'Starting @union/core runtime and HTTP health server...' });

      const coreHandle = await bootstrapCore();

      const httpHandle = createHttpServer({
        port: config.port,
        env: config.env,
        serviceVersion: coreHandle.identity.version,
        logger
      });

      await httpHandle.listen();

      logger.info('CORE_RUNNING', {
        message: 'Runtime and HTTP health server started successfully',
        context: {
          service: coreHandle.identity.service,
          version: coreHandle.identity.version,
          lifecycle: coreHandle.lifecycle.getState(),
          port: httpHandle.getPort()
        }
      });

      const shutdown = async (signal: string) => {
        logger.info('CONTROLLED_SHUTDOWN_INITIATED', {
          message: `Received ${signal}, shutting down HTTP server and Core lifecycle...`
        });
        try {
          await httpHandle.close();
          await coreHandle.stop();
          logger.info('LIFECYCLE_STOPPED', { message: 'HTTP server and Core stopped cleanly' });
        } catch (err) {
          logger.error('SHUTDOWN_ERROR', {
            message: `Error during shutdown: ${err instanceof Error ? err.message : String(err)}`
          });
          process.exit(1);
        }
      };

      process.once('SIGINT', () => { void shutdown('SIGINT'); });
      process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
    } catch (err) {
      const fallbackLogger = createLogger('core-bootstrap');
      fallbackLogger.error('CORE_BOOTSTRAP_FAILED', {
        message: `Failed to start @union/core: ${err instanceof Error ? err.message : String(err)}`,
        error: err instanceof Error ? err : new Error(String(err))
      });
      process.exit(1);
    }
  })();
}
