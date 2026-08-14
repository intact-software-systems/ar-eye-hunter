import type {
  GroupStateDisseminationMode,
} from '@shared-server/rallar-system/group-state/presence/group-presence-summary-work.ts';
import type { EnvReader } from '../../db/database-config.ts';
import { readApiGroupFormationDampingConfig } from './group-formation-damping-config.ts';

export const GROUP_STATE_DISSEMINATION_MODES = [
  'snapshot-per-change',
  'dual-emit',
  'delta-primary',
] as const satisfies readonly GroupStateDisseminationMode[];

export interface ApiGroupStateDisseminationConfig {
  readonly dissemination: GroupStateDisseminationMode;
}

const GROUP_STATE_DISSEMINATION_ENV = 'RALLAR_GROUP_STATE_DISSEMINATION';

export function readApiGroupStateDisseminationConfig(
  env: EnvReader = Deno.env,
): ApiGroupStateDisseminationConfig {
  const dissemination = readConfiguredDisseminationMode(env);
  // The issue-156 pinned replay proof depends on bit-for-bit legacy emission,
  // so legacy formation damping forces the retained snapshot-per-change engine
  // regardless of the dissemination env value.
  if (readApiGroupFormationDampingConfig(env).damping === 'legacy') {
    return { dissemination: 'snapshot-per-change' };
  }
  return { dissemination };
}

function readConfiguredDisseminationMode(env: EnvReader): GroupStateDisseminationMode {
  const raw = env.get(GROUP_STATE_DISSEMINATION_ENV);
  if (raw === undefined) return 'dual-emit';
  const value = raw.trim();
  if ((GROUP_STATE_DISSEMINATION_MODES as readonly string[]).includes(value)) {
    return value as GroupStateDisseminationMode;
  }
  throw new Error(
    `${GROUP_STATE_DISSEMINATION_ENV} must be one of ${
      GROUP_STATE_DISSEMINATION_MODES.join(', ')
    }. Received: ${value}`,
  );
}

export function groupStateDisseminationStartupLogLine(
  config: ApiGroupStateDisseminationConfig,
): string {
  return `Rallar API-v1 group-state dissemination: ${config.dissemination}`;
}

export function logGroupStateDisseminationConfig(
  log: (message: string) => void = console.log,
  config: ApiGroupStateDisseminationConfig = readApiGroupStateDisseminationConfig(),
): void {
  log(groupStateDisseminationStartupLogLine(config));
}
