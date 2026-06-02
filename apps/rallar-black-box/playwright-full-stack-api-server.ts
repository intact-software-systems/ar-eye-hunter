export const FULL_STACK_API_SERVER_MODES = [
    'postgres',
    'memory',
] as const;

export type FullStackApiServerMode = typeof FULL_STACK_API_SERVER_MODES[number];

type EnvReader = Readonly<Record<string, string | undefined>>;

export type FullStackApiV1WebServer = Readonly<{
    command: string;
    url: string;
    reuseExistingServer: boolean;
    timeout: number;
}>;

const DEFAULT_API_BASE_URL = 'http://localhost:8080';
const TEST_CORS_ORIGINS = 'http://localhost:5176,http://127.0.0.1:5176';

export function readFullStackApiServerMode(
    env: EnvReader = process.env,
): FullStackApiServerMode {
    const raw = env.RALLAR_BLACK_BOX_API_MODE?.trim();
    if (!raw) {
        return 'postgres';
    }

    if (isFullStackApiServerMode(raw)) {
        return raw;
    }

    throw new Error(
        `RALLAR_BLACK_BOX_API_MODE must be one of ${
            FULL_STACK_API_SERVER_MODES.join(', ')
        }. Received: ${raw}`,
    );
}

export function readFullStackApiBaseUrl(
    env: EnvReader = process.env,
): string {
    return normalizeBaseUrl(env.VITE_RALLAR_API_BASE_URL ?? DEFAULT_API_BASE_URL);
}

export function createFullStackApiV1WebServer(
    input: Readonly<{
        mode?: FullStackApiServerMode;
        apiBaseUrl?: string;
    }> = {},
): FullStackApiV1WebServer {
    const mode = input.mode ?? readFullStackApiServerMode();
    const apiBaseUrl = normalizeBaseUrl(
        input.apiBaseUrl ?? readFullStackApiBaseUrl(),
    );

    return {
        command: mode === 'memory'
            ? createMemoryApiCommand(apiBaseUrl)
            : createPostgresApiCommand(apiBaseUrl),
        url: `${apiBaseUrl}/api/config`,
        reuseExistingServer: true,
        timeout: mode === 'memory' ? 120_000 : 90_000,
    };
}

export function createFullStackMemoryEnvBlock(): string {
    return [
        'RALLAR_SQL_BACKEND=pglite-memory',
        'RALLAR_PGLITE_DATA_DIR=memory://',
        'RALLAR_PGLITE_SCHEMA_INIT=auto',
        'RALLAR_DB_PUBSUB=local',
        'RALLAR_ICE_MODE=local',
        'RALLAR_LOGIN_USER_RATE_LIMIT=100',
    ].join(' ');
}

export function createFullStackApiUrlEnvBlock(apiBaseUrl: string): string {
    const normalizedApiBaseUrl = normalizeBaseUrl(apiBaseUrl);
    return [
        `RALLAR_API_BASE_URL=${normalizedApiBaseUrl}`,
        `RALLAR_WS_BASE_URL=${toWsBaseUrl(normalizedApiBaseUrl)}`,
    ].join(' ');
}

function createMemoryApiCommand(apiBaseUrl: string): string {
    return `cd ../.. && CORS_ORIGINS=${TEST_CORS_ORIGINS} PORT=${portFromBaseUrl(apiBaseUrl)} ${
        createFullStackApiUrlEnvBlock(apiBaseUrl)
    } ${createFullStackMemoryEnvBlock()} deno run --config apps/api-v1/deno.json --allow-net --allow-env --allow-read apps/api-v1/src/main.ts`;
}

function createPostgresApiCommand(apiBaseUrl: string): string {
    return `cd ../.. && CORS_ORIGINS=${TEST_CORS_ORIGINS} PORT=${portFromBaseUrl(apiBaseUrl)} ${
        createFullStackApiUrlEnvBlock(apiBaseUrl)
    } deno run --env-file=apps/api-v1/.env.local --env-file=apps/api-v1/.env --env-file=.env --config apps/api-v1/deno.json --allow-net --allow-env --allow-read apps/api-v1/src/main.ts`;
}

function normalizeBaseUrl(value: string): string {
    return value.endsWith('/') ? value.slice(0, -1) : value;
}

function portFromBaseUrl(apiBaseUrl: string): number {
    const url = new URL(apiBaseUrl);
    if (url.port) {
        return Number(url.port);
    }

    return url.protocol === 'https:' ? 443 : 80;
}

function toWsBaseUrl(apiBaseUrl: string): string {
    const url = new URL(apiBaseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return normalizeBaseUrl(url.toString());
}

function isFullStackApiServerMode(
    value: string,
): value is FullStackApiServerMode {
    return FULL_STACK_API_SERVER_MODES.includes(value as FullStackApiServerMode);
}
