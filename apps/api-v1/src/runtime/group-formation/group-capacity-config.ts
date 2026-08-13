import type { EnvReader } from '../../db/database-config.ts';

export interface ApiGroupCapacityConfig {
  readonly defaultMaxMembers: number | null;
}

const GROUP_DEFAULT_MAX_MEMBERS_ENV = 'RALLAR_GROUP_DEFAULT_MAX_MEMBERS';
const GROUP_DEFAULT_MAX_MEMBERS = 256;

export function readApiGroupCapacityConfig(
  env: EnvReader = Deno.env,
): ApiGroupCapacityConfig {
  const raw = env.get(GROUP_DEFAULT_MAX_MEMBERS_ENV);
  if (raw === undefined || raw.trim().length === 0) {
    return { defaultMaxMembers: GROUP_DEFAULT_MAX_MEMBERS };
  }
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `${GROUP_DEFAULT_MAX_MEMBERS_ENV} must be a positive integer, or 0 to ` +
        `disable the default member cap. Received: ${raw.trim()}`,
    );
  }
  return { defaultMaxMembers: value === 0 ? null : value };
}
