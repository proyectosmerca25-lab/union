export const UNION_SYSTEM_VERSION = '1.0.0-F1.2';

export interface SystemContract {
  name: string;
  version: string;
  status: 'FROZEN' | 'ACTIVE';
}

export function getSystemBaseline(): SystemContract {
  return {
    name: 'UNIÓN System Architecture',
    version: UNION_SYSTEM_VERSION,
    status: 'FROZEN'
  };
}
