import type { EnvReader } from '../../db/database-config.ts';

export const GROUP_FORMATION_DAMPING_MODES = ['damped', 'legacy'] as const;

export type GroupFormationDampingMode = typeof GROUP_FORMATION_DAMPING_MODES[number];

export interface ApiGroupFormationDampingConfig {
  readonly damping: GroupFormationDampingMode;
}

const GROUP_FORMATION_DAMPING_ENV = 'RALLAR_GROUP_FORMATION_DAMPING';

export function readApiGroupFormationDampingConfig(
  env: EnvReader = Deno.env,
): ApiGroupFormationDampingConfig {
  const raw = env.get(GROUP_FORMATION_DAMPING_ENV);
  if (raw === undefined) return { damping: 'damped' };
  const value = raw.trim();
  if ((GROUP_FORMATION_DAMPING_MODES as readonly string[]).includes(value)) {
    return { damping: value as GroupFormationDampingMode };
  }
  throw new Error(
    `${GROUP_FORMATION_DAMPING_ENV} must be one of ${
      GROUP_FORMATION_DAMPING_MODES.join(', ')
    }. Received: ${value}`,
  );
}

export function groupFormationDampingStartupLogLine(
  config: ApiGroupFormationDampingConfig,
): string {
  return `Rallar API-v1 group formation damping: ${config.damping}`;
}

export function logGroupFormationDampingConfig(
  log: (message: string) => void = console.log,
  config: ApiGroupFormationDampingConfig = readApiGroupFormationDampingConfig(),
): void {
  log(groupFormationDampingStartupLogLine(config));
}
