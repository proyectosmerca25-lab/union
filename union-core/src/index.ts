import { getSystemBaseline, SystemContract } from '@union/shared';

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
