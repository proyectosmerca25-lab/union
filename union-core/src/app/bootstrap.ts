import { getSystemBaseline, SystemContract } from '@union/shared';
import { CoreLifecycle } from './lifecycle.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('bootstrap');

export interface CoreRuntimeIdentity {
  service: string;
  version: string;
  baseline: SystemContract;
}

export interface CoreRuntimeHandle {
  lifecycle: CoreLifecycle;
  identity: CoreRuntimeIdentity;
  stop: () => Promise<void>;
  detachSignalListeners: () => void;
}

export interface BootstrapOptions {
  attachSignalListeners?: boolean;
}

export async function bootstrapCore(options: BootstrapOptions = {}): Promise<CoreRuntimeHandle> {
  const lifecycle = new CoreLifecycle();
  const baseline = getSystemBaseline();

  const identity: CoreRuntimeIdentity = {
    service: '@union/core',
    version: '0.1.0-F1.3',
    baseline
  };

  let sigintHandler: (() => void) | null = null;
  let sigtermHandler: (() => void) | null = null;

  const detachSignalListeners = (): void => {
    if (sigintHandler) {
      process.removeListener('SIGINT', sigintHandler);
      sigintHandler = null;
    }
    if (sigtermHandler) {
      process.removeListener('SIGTERM', sigtermHandler);
      sigtermHandler = null;
    }
  };

  if (options.attachSignalListeners) {
    const handleSignal = async (signal: string): Promise<void> => {
      logger.info('CONTROLLED_SHUTDOWN_INITIATED', {
        message: `Received signal ${signal}, initiating controlled shutdown...`
      });
      try {
        await lifecycle.stop();
        logger.info('LIFECYCLE_STOPPED', {
          message: `Lifecycle stopped successfully (${lifecycle.getState()})`
        });
      } finally {
        detachSignalListeners();
      }
    };

    sigintHandler = () => { void handleSignal('SIGINT'); };
    sigtermHandler = () => { void handleSignal('SIGTERM'); };

    process.on('SIGINT', sigintHandler);
    process.on('SIGTERM', sigtermHandler);
  }

  await lifecycle.start();

  return {
    lifecycle,
    identity,
    stop: async () => {
      try {
        await lifecycle.stop();
      } finally {
        detachSignalListeners();
      }
    },
    detachSignalListeners
  };
}
