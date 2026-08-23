import type {
    GroupStateDisseminationMode
} from '@shared-server/rallar-system/group-state/presence/group-presence-summary-effects.ts';
import type { EnvReader } from '../../db/database-config.ts';

export const GROUP_STATE_DISSEMINATION_MODES = [
    'dual-emit',
    'delta-primary'
] as const satisfies readonly GroupStateDisseminationMode[];

export interface ApiGroupStateDisseminationConfig {
    readonly dissemination: GroupStateDisseminationMode;
}

const GROUP_STATE_DISSEMINATION_ENV = 'RALLAR_GROUP_STATE_DISSEMINATION';

export function readApiGroupStateDisseminationConfig(
    env: EnvReader = Deno.env
): ApiGroupStateDisseminationConfig {
    return { dissemination: readConfiguredDisseminationMode(env) };
}

function readConfiguredDisseminationMode(env: EnvReader): GroupStateDisseminationMode {
    const raw = env.get(GROUP_STATE_DISSEMINATION_ENV);
    if (raw === undefined) {
        return 'delta-primary';
    }
    const value = raw.trim();
    if ((GROUP_STATE_DISSEMINATION_MODES as readonly string[]).includes(value)) {
        return value as GroupStateDisseminationMode;
    }
    throw new Error(
        `${GROUP_STATE_DISSEMINATION_ENV} must be one of ${
            GROUP_STATE_DISSEMINATION_MODES.join(', ')
        }. Received: ${value}`
    );
}

export function groupStateDisseminationStartupLogLine(
    config: ApiGroupStateDisseminationConfig
): string {
    return `Rallar API-v1 group-state dissemination: ${config.dissemination}`;
}

export function logGroupStateDisseminationConfig(
    log: (message: string) => void = console.log,
    config: ApiGroupStateDisseminationConfig = readApiGroupStateDisseminationConfig()
): void {
    log(groupStateDisseminationStartupLogLine(config));
}
