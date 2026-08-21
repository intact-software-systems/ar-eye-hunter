export const RALLAR_SQL_BACKENDS = [
    'postgres',
    'pglite-memory',
    'pglite-file'
] as const;

export type RallarSqlBackend = typeof RALLAR_SQL_BACKENDS[number];

export type EnvReader = Readonly<{
    get(name: string): string | undefined;
}>;

export type ApiV1DatabaseBackendConfig = Readonly<{
    sqlBackend: RallarSqlBackend;
    databaseUrl?: string;
    pgliteDataDir?: string;
    pgliteSchemaInit?: PGliteSchemaInitMode;
}>;

const SQL_BACKEND_ENV = 'RALLAR_SQL_BACKEND';
const DATABASE_URL_ENV = 'DATABASE_URL';
const PGLITE_DATA_DIR_ENV = 'RALLAR_PGLITE_DATA_DIR';
const PGLITE_SCHEMA_INIT_ENV = 'RALLAR_PGLITE_SCHEMA_INIT';

export const PGLITE_SCHEMA_INIT_MODES = [
    'auto',
    'disabled'
] as const;

export type PGliteSchemaInitMode = typeof PGLITE_SCHEMA_INIT_MODES[number];

export function readRallarSqlBackend(env: EnvReader = Deno.env): RallarSqlBackend {
    const raw = env.get(SQL_BACKEND_ENV)?.trim();
    if (!raw) {
        return 'postgres';
    }

    if (isRallarSqlBackend(raw)) {
        return raw;
    }

    throw new Error(
        `${SQL_BACKEND_ENV} must be one of ${RALLAR_SQL_BACKENDS.join(', ')}. Received: ${raw}`
    );
}

export function readApiV1DatabaseBackendConfig(
    env: EnvReader = Deno.env
): ApiV1DatabaseBackendConfig {
    const databaseUrl = env.get(DATABASE_URL_ENV)?.trim();
    const pgliteDataDir = env.get(PGLITE_DATA_DIR_ENV)?.trim();
    const pgliteSchemaInit = readPGliteSchemaInitMode(env);
    return {
        sqlBackend: readRallarSqlBackend(env),
        ...(databaseUrl ? { databaseUrl } : {}),
        ...(pgliteDataDir ? { pgliteDataDir } : {}),
        ...(pgliteSchemaInit ? { pgliteSchemaInit } : {})
    };
}

export function requirePostgresDatabaseUrl(
    config: ApiV1DatabaseBackendConfig = readApiV1DatabaseBackendConfig()
): string {
    if (config.sqlBackend !== 'postgres') {
        throw new Error(
            `DATABASE_URL is only required for RALLAR_SQL_BACKEND=postgres. ` +
                `Configured backend: ${config.sqlBackend}`
        );
    }

    if (!config.databaseUrl) {
        throw new Error('DATABASE_URL missing for RALLAR_SQL_BACKEND=postgres');
    }

    return config.databaseUrl;
}

export function databaseBackendStartupLogLine(
    config: ApiV1DatabaseBackendConfig = readApiV1DatabaseBackendConfig()
): string {
    const databaseUrlStatus = config.sqlBackend === 'postgres'
        ? config.databaseUrl ? 'configured' : 'not configured'
        : config.databaseUrl
        ? 'ignored'
        : 'not configured';
    const pgliteDataDirStatus = config.pgliteDataDir ? 'configured' : 'default';
    return `Rallar API-v1 SQL backend: ${config.sqlBackend}; DATABASE_URL: ${databaseUrlStatus}; RALLAR_PGLITE_DATA_DIR: ${pgliteDataDirStatus}`;
}

export function logDatabaseBackendConfig(
    log: (message: string) => void = console.log,
    config: ApiV1DatabaseBackendConfig = readApiV1DatabaseBackendConfig()
): void {
    log(databaseBackendStartupLogLine(config));
}

function isRallarSqlBackend(value: string): value is RallarSqlBackend {
    return RALLAR_SQL_BACKENDS.includes(value as RallarSqlBackend);
}

export function readPGliteSchemaInitMode(
    env: EnvReader = Deno.env
): PGliteSchemaInitMode | undefined {
    const raw = env.get(PGLITE_SCHEMA_INIT_ENV)?.trim();
    if (!raw) {
        return undefined;
    }

    if (isPGliteSchemaInitMode(raw)) {
        return raw;
    }

    throw new Error(
        `${PGLITE_SCHEMA_INIT_ENV} must be one of ${PGLITE_SCHEMA_INIT_MODES.join(', ')}. ` +
            `Received: ${raw}`
    );
}

export function resolvePGliteSchemaInitMode(
    config: ApiV1DatabaseBackendConfig = readApiV1DatabaseBackendConfig()
): PGliteSchemaInitMode {
    const mode = config.pgliteSchemaInit ?? (
        config.sqlBackend === 'postgres' ? 'disabled' : 'auto'
    );

    if (mode === 'auto' && config.sqlBackend === 'postgres') {
        throw new Error(
            `${PGLITE_SCHEMA_INIT_ENV}=auto requires a PGlite SQL backend. ` +
                `Configured backend: ${config.sqlBackend}`
        );
    }

    return mode;
}

export function pgliteSchemaInitStartupLogLine(
    config: ApiV1DatabaseBackendConfig = readApiV1DatabaseBackendConfig()
): string {
    return `Rallar API-v1 PGlite schema init: ${resolvePGliteSchemaInitMode(config)}`;
}

export function logPGliteSchemaInitConfig(
    log: (message: string) => void = console.log,
    config: ApiV1DatabaseBackendConfig = readApiV1DatabaseBackendConfig()
): void {
    log(pgliteSchemaInitStartupLogLine(config));
}

export function resolvePGliteDataDir(
    config: ApiV1DatabaseBackendConfig = readApiV1DatabaseBackendConfig()
): string {
    if (config.sqlBackend === 'pglite-memory') {
        return config.pgliteDataDir ?? 'memory://';
    }

    if (config.sqlBackend === 'pglite-file') {
        if (!config.pgliteDataDir || config.pgliteDataDir === 'memory://') {
            throw new Error(
                `${PGLITE_DATA_DIR_ENV} must be configured to a filesystem path for ` +
                    'RALLAR_SQL_BACKEND=pglite-file'
            );
        }

        return config.pgliteDataDir;
    }

    throw new Error(
        `${PGLITE_DATA_DIR_ENV} is only used for PGlite backends. ` +
            `Configured backend: ${config.sqlBackend}`
    );
}

function isPGliteSchemaInitMode(value: string): value is PGliteSchemaInitMode {
    return PGLITE_SCHEMA_INIT_MODES.includes(value as PGliteSchemaInitMode);
}
