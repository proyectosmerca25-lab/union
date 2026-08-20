import url from 'node:url';
import { bootstrapCore, CoreRuntimeHandle, CoreRuntimeIdentity } from './app/bootstrap.js';
import { CoreLifecycle, InvalidLifecycleTransitionError, LifecycleState } from './app/lifecycle.js';
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
import { getSystemBaseline, SystemContract } from '@union/shared';

export {
  CoreLifecycle,
  InvalidLifecycleTransitionError,
  LifecycleState,
  bootstrapCore,
  CoreRuntimeHandle,
  CoreRuntimeIdentity,
  runMigrations,
  computeChecksum,
  discoverMigrations,
  getResolvedConfig,
  MigrationConfig,
  MigrationResult,
  MissingDatabaseConfigurationError,
  MalformedMigrationIdentityError,
  DuplicateMigrationIdentityError,
  ChecksumMismatchError
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
    console.log('[CORE] Starting @union/core runtime skeleton...');
    const handle = await bootstrapCore({ attachSignalListeners: true });
    console.log(`[CORE] Runtime started. Service: ${handle.identity.service}, Version: ${handle.identity.version}, Lifecycle: ${handle.lifecycle.getState()}`);
  })();
}
