import { type ApiV1DatabaseBackendConfig, readApiV1DatabaseBackendConfig, } from './database-config.ts';

export const RALLAR_DB_PUBSUB_MODES = [
    'postgres',
    'local',
    'disabled',
] as const;

export type RallarDbPubSubMode = typeof RALLAR_DB_PUBSUB_MODES[number];

export type ApiV1DatabasePubSubConfig = Readonly<{
    mode: RallarDbPubSubMode;
}>;

type EnvReader = Readonly<{
    get(name: string): string | undefined;
}>;

const DB_PUBSUB_ENV = 'RALLAR_DB_PUBSUB';

export function readApiV1DatabasePubSubConfig(
    env: EnvReader = Deno.env,
    databaseConfig: ApiV1DatabaseBackendConfig = readApiV1DatabaseBackendConfig(env),
): ApiV1DatabasePubSubConfig {
    return {
        mode: readRallarDbPubSubMode(env, databaseConfig),
    };
}

export function readRallarDbPubSubMode(
    env: EnvReader = Deno.env,
    databaseConfig: ApiV1DatabaseBackendConfig = readApiV1DatabaseBackendConfig(env),
): RallarDbPubSubMode {
    const raw = env.get(DB_PUBSUB_ENV)?.trim();
    if (!raw) {
        return defaultRallarDbPubSubMode(databaseConfig);
    }

    if (isRallarDbPubSubMode(raw)) {
        validateRallarDbPubSubModeForSqlBackend(raw, databaseConfig);
        return raw;
    }

    throw new Error(
        `${DB_PUBSUB_ENV} must be one of ${RALLAR_DB_PUBSUB_MODES.join(', ')}. Received: ${raw}`,
    );
}

export function validateRallarDbPubSubModeForSqlBackend(
    mode: RallarDbPubSubMode,
    databaseConfig: Pick<ApiV1DatabaseBackendConfig, 'sqlBackend'>,
): void {
    if (mode === 'postgres' && databaseConfig.sqlBackend !== 'postgres') {
        throw new Error(
            `${DB_PUBSUB_ENV}=postgres requires RALLAR_SQL_BACKEND=postgres. ` +
            `Configured SQL backend: ${databaseConfig.sqlBackend}`,
        );
    }
}

export function defaultRallarDbPubSubMode(
    databaseConfig: Pick<ApiV1DatabaseBackendConfig, 'sqlBackend'>,
): RallarDbPubSubMode {
    return databaseConfig.sqlBackend === 'postgres' ? 'postgres' : 'local';
}

export function databasePubSubStartupLogLine(
    config: ApiV1DatabasePubSubConfig = readApiV1DatabasePubSubConfig(),
): string {
    return `Rallar API-v1 DB pub/sub: ${config.mode}`;
}

export function logDatabasePubSubConfig(
    log: (message: string) => void = console.log,
    config: ApiV1DatabasePubSubConfig = readApiV1DatabasePubSubConfig(),
): void {
    log(databasePubSubStartupLogLine(config));
}

function isRallarDbPubSubMode(value: string): value is RallarDbPubSubMode {
    return RALLAR_DB_PUBSUB_MODES.includes(value as RallarDbPubSubMode);
}
