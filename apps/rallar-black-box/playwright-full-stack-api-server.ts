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
const DEFAULT_SPA_BASE_URL = 'http://localhost:5176';

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

export function readFullStackSpaBaseUrl(
    env: EnvReader = process.env,
): string {
    return normalizeBaseUrl(env.VITE_RALLAR_SPA_BASE_URL ?? DEFAULT_SPA_BASE_URL);
}

export function createFullStackApiV1WebServer(
    input: Readonly<{
        mode?: FullStackApiServerMode;
        apiBaseUrl?: string;
        spaBaseUrl?: string;
        reuseExistingServer?: boolean;
        requireFreshPostgres?: boolean;
    }> = {},
): FullStackApiV1WebServer {
    const mode = input.mode ?? readFullStackApiServerMode();
    if (input.requireFreshPostgres === true && mode !== 'postgres') {
        throw new Error('Fresh Postgres API isolation requires mode postgres.');
    }
    const apiBaseUrl = normalizeBaseUrl(
        input.apiBaseUrl ?? readFullStackApiBaseUrl(),
    );
    const spaBaseUrl = normalizeBaseUrl(
        input.spaBaseUrl ?? readFullStackSpaBaseUrl(),
    );

    return {
        command: mode === 'memory'
            ? createMemoryApiCommand(apiBaseUrl, spaBaseUrl)
            : createPostgresApiCommand(apiBaseUrl, spaBaseUrl),
        url: `${apiBaseUrl}/api/config`,
        reuseExistingServer: input.requireFreshPostgres === true
            ? false
            : input.reuseExistingServer ?? true,
        timeout: mode === 'memory' ? 120_000 : 90_000,
    };
}

export function assertFullStackApiConfigEvidence(
    value: unknown,
    expectedApiBaseUrl: string,
): void {
    if (!isRecord(value)) {
        throw new Error('Configured API configuration must be a JSON object.');
    }
    const apiBaseUrl = normalizeBaseUrl(expectedApiBaseUrl);
    if (value.apiBaseUrl !== apiBaseUrl) {
        throw new Error(
            `Configured API apiBaseUrl must be ${apiBaseUrl}. Received: ${String(value.apiBaseUrl)}`,
        );
    }
    const wsBaseUrl = toWsBaseUrl(apiBaseUrl);
    if (value.wsBaseUrl !== wsBaseUrl) {
        throw new Error(
            `Configured API wsBaseUrl must be ${wsBaseUrl}. Received: ${String(value.wsBaseUrl)}`,
        );
    }
    if (!isRecord(value.endpoints) ||
        typeof value.endpoints.createWs !== 'string' ||
        value.endpoints.createWs.trim().length === 0
    ) {
        throw new Error(
            'Configured API endpoints.createWs must be a non-empty string.',
        );
    }
}

export function assertFullStackReadinessHttpEvidence(input: Readonly<{
    service: 'API' | 'control';
    ok: boolean;
    status: number;
    statusText: string;
}>): void {
    if (!input.ok) {
        throw new Error(
            `Configured ${input.service} readiness returned HTTP ${input.status} ${input.statusText}.`,
        );
    }
}

export function assertFullStackControlHealthEvidence(value: unknown): void {
    if (!isRecord(value)) {
        throw new Error('Configured control health must be a JSON object.');
    }
    if (value.ok !== true) {
        throw new Error(`Configured control health ok must be true. Received: ${String(value.ok)}`);
    }
    if (value.app !== 'rallar-black-box-control-server') {
        throw new Error(
            `Configured control health app must be rallar-black-box-control-server. Received: ${String(value.app)}`,
        );
    }
    if (value.protocolVersion !== 1) {
        throw new Error(
            `Configured control health protocolVersion must be 1. Received: ${String(value.protocolVersion)}`,
        );
    }
}

export type FullStackConfiguredServiceProbe =
    | Readonly<{ kind: 'unavailable' }>
    | Readonly<{
        kind: 'reachable';
        ok: boolean;
        status: number;
        statusText: string;
        readJson(): Promise<unknown>;
    }>;

export async function evaluateFullStackConfiguredServiceEvidence(
    input: Readonly<{
        api: FullStackConfiguredServiceProbe;
        control: FullStackConfiguredServiceProbe;
        expectedApiBaseUrl: string;
    }>,
): Promise<'ready' | 'unavailable'> {
    if (input.api.kind === 'reachable') {
        assertFullStackReadinessHttpEvidence({
            service: 'API',
            ok: input.api.ok,
            status: input.api.status,
            statusText: input.api.statusText,
        });
        assertFullStackApiConfigEvidence(
            await input.api.readJson(),
            input.expectedApiBaseUrl,
        );
    }
    if (input.control.kind === 'reachable') {
        assertFullStackReadinessHttpEvidence({
            service: 'control',
            ok: input.control.ok,
            status: input.control.status,
            statusText: input.control.statusText,
        });
        assertFullStackControlHealthEvidence(await input.control.readJson());
    }
    return input.api.kind === 'unavailable' || input.control.kind === 'unavailable'
        ? 'unavailable'
        : 'ready';
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

export function createFullStackSpaCorsOrigins(spaBaseUrl: string): string {
    const normalizedSpaBaseUrl = normalizeBaseUrl(spaBaseUrl);
    const url = new URL(normalizedSpaBaseUrl);
    const origins = [url.origin];
    if (url.hostname === 'localhost') {
        url.hostname = '127.0.0.1';
        origins.push(url.origin);
    } else if (url.hostname === '127.0.0.1') {
        url.hostname = 'localhost';
        origins.push(url.origin);
    }
    return origins.join(',');
}

export function portFromBaseUrl(apiBaseUrl: string): number {
    const url = new URL(apiBaseUrl);
    if (url.port) {
        return Number(url.port);
    }

    return url.protocol === 'https:' ? 443 : 80;
}

function createMemoryApiCommand(apiBaseUrl: string, spaBaseUrl: string): string {
    return `cd ../.. && CORS_ORIGINS=${createFullStackSpaCorsOrigins(spaBaseUrl)} PORT=${portFromBaseUrl(apiBaseUrl)} ${
        createFullStackApiUrlEnvBlock(apiBaseUrl)
    } ${createFullStackMemoryEnvBlock()} deno run --config apps/api-v1/deno.json --allow-net --allow-env --allow-read apps/api-v1/src/main.ts`;
}

function createPostgresApiCommand(apiBaseUrl: string, spaBaseUrl: string): string {
    return `cd ../.. && RALLAR_SQL_BACKEND=postgres CORS_ORIGINS=${createFullStackSpaCorsOrigins(spaBaseUrl)} PORT=${portFromBaseUrl(apiBaseUrl)} ${
        createFullStackApiUrlEnvBlock(apiBaseUrl)
    } deno run --env-file=apps/api-v1/.env.local --env-file=apps/api-v1/.env --env-file=.env --config apps/api-v1/deno.json --allow-net --allow-env --allow-read apps/api-v1/src/main.ts`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeBaseUrl(value: string): string {
    return value.endsWith('/') ? value.slice(0, -1) : value;
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
