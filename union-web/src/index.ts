import { UNION_SYSTEM_VERSION } from '@union/shared';

export interface WebStatus {
  app: string;
  ready: boolean;
  systemVersion: string;
}

export function getWebStatus(): WebStatus {
  return {
    app: '@union/web',
    ready: true,
    systemVersion: UNION_SYSTEM_VERSION
  };
}
