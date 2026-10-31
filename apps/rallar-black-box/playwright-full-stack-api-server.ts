import path from 'node:path';

import {
    readFullStackRtcIceFixtureRequests,
    type ReadFullStackRtcIceFixtureRequestsInput
} from '../../packages/shared-test/black-box-runner/fixtures/read-full-stack-rtc-ice-fixture-requests.ts';
import { ALM_CONFORMANCE_GRANTED_TOPIC_ID } from '../../packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-step-identities.ts';

export type FullStackApiServerMode = typeof FULL_STACK_API_SERVER_MODES[number];

export interface FullStackApiV1WebServer {
    readonly command: string;
    readonly url: string;
    readonly reuseExistingServer: boolean;
    readonly timeout: number;
    readonly gracefulShutdown?: { readonly signal: 'SIGTERM'; readonly timeout: number; };
}

export interface DefaultFullStackApiV1WebServerInput {
    readonly mode?: FullStackApiServerMode;
    readonly apiBaseUrl?: string;
    readonly spaBaseUrl?: string;
    readonly reuseExistingServer?: boolean;
    readonly requireFreshPostgres?: boolean;
    readonly timingCaptureDirectory?: string;
    readonly appInboxPhaseTiming?: boolean;
    readonly environment?: Readonly<NodeJS.ProcessEnv>;
    readonly admittedRtcCaseId?: ReadFullStackRtcIceFixtureRequestsInput['admittedCaseId'];
}

export interface FullStackApiV1WebServerInput {
    readonly mode: FullStackApiServerMode;
    readonly apiBaseUrl: string;
    readonly spaBaseUrl: string;
    readonly reuseExistingServer: boolean;
    readonly requireFreshPostgres: boolean;
    readonly timingCaptureDirectory?: string;
    readonly appInboxPhaseTiming: boolean;
    readonly environment: Readonly<NodeJS.ProcessEnv>;
    readonly admittedRtcCaseId: ReadFullStackRtcIceFixtureRequestsInput['admittedCaseId'];
}

export interface FullStackReadinessHttpEvidence {
    readonly service: 'API' | 'control';
    readonly ok: boolean;
    readonly status: number;
    readonly statusText: string;
}

export type FullStackConfiguredServiceProbe =
    | Readonly<{ kind: 'unavailable'; }>
    | Readonly<{
        kind: 'reachable';
        ok: boolean;
        status: number;
        statusText: string;
        readJson(): Promise<unknown>;
    }>;

export interface FullStackConfiguredServiceEvidenceInput {
    readonly api: FullStackConfiguredServiceProbe;
    readonly control: FullStackConfiguredServiceProbe;
    readonly expectedApiBaseUrl: string;
}

interface MemoryApiCommandInput {
    readonly apiBaseUrl: string;
    readonly spaBaseUrl: string;
    readonly apiInvocation: string;
    readonly iceRequests: number;
}

const FULL_STACK_API_SERVER_MODES = [
    'postgres',
    'memory'
] as const;

const DEFAULT_API_BASE_URL = 'http://localhost:8080';
const DEFAULT_SPA_BASE_URL = 'http://localhost:5176';
const CO_LOCATED_AGENT_CEILING = 50;
const AUTH_REQUESTS_PER_CO_LOCATED_AGENT_PER_WINDOW = 4;
const CO_LOCATED_AUTH_IP_RATE_LIMIT = CO_LOCATED_AGENT_CEILING * AUTH_REQUESTS_PER_CO_LOCATED_AGENT_PER_WINDOW;
const REQUIRE_LAUNCHING_DATABASE_URL =
    ': "${DATABASE_URL:?must be set in the launching environment; the local Postgres API loads no env files}"';

export function readFullStackApiServerMode(
    env: Readonly<NodeJS.ProcessEnv> = process.env
): FullStackApiServerMode {
    const raw = env.RALLAR_BLACK_BOX_API_MODE?.trim();
    if (!raw) {
        return 'postgres';
    }

    if (isFullStackApiServerMode(raw)) {
        return raw;
    }

    throw new Error(
        `RALLAR_BLACK_BOX_API_MODE must be one of ${FULL_STACK_API_SERVER_MODES.join(', ')}. Received: ${raw}`
    );
}

export function readFullStackApiBaseUrl(
    env: Readonly<NodeJS.ProcessEnv> = process.env
): string {
    return normalizeBaseUrl(env.VITE_RALLAR_API_BASE_URL ?? DEFAULT_API_BASE_URL);
}

export function readFullStackSpaBaseUrl(
    env: Readonly<NodeJS.ProcessEnv> = process.env
): string {
    return normalizeBaseUrl(env.VITE_RALLAR_SPA_BASE_URL ?? DEFAULT_SPA_BASE_URL);
}

export function createDefaultFullStackApiV1WebServer(
    input: DefaultFullStackApiV1WebServerInput = {}
): FullStackApiV1WebServer {
    const environment = input.environment ?? process.env;
    return createFullStackApiV1WebServer({
        mode: input.mode ?? readFullStackApiServerMode(environment),
        apiBaseUrl: input.apiBaseUrl ?? readFullStackApiBaseUrl(environment),
        spaBaseUrl: input.spaBaseUrl ?? readFullStackSpaBaseUrl(environment),
        reuseExistingServer: input.reuseExistingServer ?? true,
        requireFreshPostgres: input.requireFreshPostgres ?? false,
        timingCaptureDirectory: input.timingCaptureDirectory,
        appInboxPhaseTiming: input.appInboxPhaseTiming ?? true,
        environment,
        admittedRtcCaseId: input.admittedRtcCaseId ?? null
    });
}

export function createFullStackApiV1WebServer(
    input: FullStackApiV1WebServerInput
): FullStackApiV1WebServer {
    const { mode } = input;
    if (input.requireFreshPostgres && mode !== 'postgres') {
        throw new Error('Fresh Postgres API isolation requires mode postgres.');
    }
    const apiBaseUrl = normalizeBaseUrl(input.apiBaseUrl);
    const spaBaseUrl = normalizeBaseUrl(input.spaBaseUrl);

    const apiInvocation = toFullStackApiInvocation(input.timingCaptureDirectory, mode, input.appInboxPhaseTiming);
    const iceRequests = mode === 'memory'
        ? readFullStackRtcIceFixtureRequests({
            environment: input.environment,
            admittedCaseId: input.admittedRtcCaseId
        })
        : 20;
    return {
        command: mode === 'memory'
            ? createMemoryApiCommand({ apiBaseUrl, spaBaseUrl, apiInvocation, iceRequests })
            : createPostgresApiCommand(apiBaseUrl, spaBaseUrl, apiInvocation),
        url: `${apiBaseUrl}/api/config`,
        reuseExistingServer:
            mode === 'memory' || input.requireFreshPostgres === true || input.timingCaptureDirectory !== undefined
                ? false
                : input.reuseExistingServer,
        timeout: mode === 'memory' ? 120_000 : 90_000,
        ...(input.timingCaptureDirectory === undefined
            ? {}
            : { gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 7_000 } })
    };
}

export function assertFullStackApiConfigEvidence(
    value: unknown,
    expectedApiBaseUrl: string
): void {
    if (!isRecord(value)) {
        throw new Error('Configured API configuration must be a JSON object.');
    }
    const apiBaseUrl = normalizeBaseUrl(expectedApiBaseUrl);
    if (value.apiBaseUrl !== apiBaseUrl) {
        throw new Error(
            `Configured API apiBaseUrl must be ${apiBaseUrl}. Received: ${String(value.apiBaseUrl)}`
        );
    }
    const wsBaseUrl = toWsBaseUrl(apiBaseUrl);
    if (value.wsBaseUrl !== wsBaseUrl) {
        throw new Error(
            `Configured API wsBaseUrl must be ${wsBaseUrl}. Received: ${String(value.wsBaseUrl)}`
        );
    }
    if (
        !isRecord(value.endpoints) ||
        typeof value.endpoints.createWs !== 'string' ||
        value.endpoints.createWs.trim().length === 0
    ) {
        throw new Error(
            'Configured API endpoints.createWs must be a non-empty string.'
        );
    }
}

export function assertFullStackReadinessHttpEvidence(
    input: FullStackReadinessHttpEvidence
): void {
    if (!input.ok) {
        throw new Error(
            `Configured ${input.service} readiness returned HTTP ${input.status} ${input.statusText}.`
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
            `Configured control health app must be rallar-black-box-control-server. Received: ${String(value.app)}`
        );
    }
    if (value.protocolVersion !== 1) {
        throw new Error(
            `Configured control health protocolVersion must be 1. Received: ${String(value.protocolVersion)}`
        );
    }
}

export async function evaluateFullStackConfiguredServiceEvidence(
    input: FullStackConfiguredServiceEvidenceInput
): Promise<'ready' | 'unavailable'> {
    if (input.api.kind === 'reachable') {
        assertFullStackReadinessHttpEvidence({
            service: 'API',
            ok: input.api.ok,
            status: input.api.status,
            statusText: input.api.statusText
        });
        assertFullStackApiConfigEvidence(
            await input.api.readJson(),
            input.expectedApiBaseUrl
        );
    }
    if (input.control.kind === 'reachable') {
        assertFullStackReadinessHttpEvidence({
            service: 'control',
            ok: input.control.ok,
            status: input.control.status,
            statusText: input.control.statusText
        });
        assertFullStackControlHealthEvidence(await input.control.readJson());
    }
    return input.api.kind === 'unavailable' || input.control.kind === 'unavailable'
        ? 'unavailable'
        : 'ready';
}

/**
 * Space-separated assignments the shell command prefixes. The granted topic's JSON holds no space, and its single
 * quotes keep the shell from expanding its braces or removing its double quotes.
 */
export function createFullStackApiProfileEnvBlock(): string {
    const grantedTopics = [{ topicId: ALM_CONFORMANCE_GRANTED_TOPIC_ID, fanout: 'outbox', serverProducerIds: [] }];
    return [
        'RALLAR_API_CONFIGURATION_PROFILE=prod-in-memory',
        'RALLAR_ROOM_OWNED_APP_DATA_BINDINGS_JSON=[]',
        'RALLAR_LOGIN_USER_RATE_LIMIT=100',
        `RALLAR_REGISTRATION_IP_RATE_LIMIT=${CO_LOCATED_AUTH_IP_RATE_LIMIT}`,
        `RALLAR_LOGIN_IP_RATE_LIMIT=${CO_LOCATED_AUTH_IP_RATE_LIMIT}`,
        'RALLAR_AUTH_CREDENTIAL_SECRET=local-rallar-full-stack-auth-credential-secret-v1',
        'RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET=local-rallar-full-stack-operator-secret-v1',
        `RALLAR_GRANTED_WS_TOPICS_JSON='${JSON.stringify(grantedTopics)}'`
    ].join(' ');
}

export function portFromBaseUrl(apiBaseUrl: string): number {
    const url = new URL(apiBaseUrl);
    if (url.port) {
        return Number(url.port);
    }

    return url.protocol === 'https:' ? 443 : 80;
}

function createFullStackApiUrlEnvBlock(apiBaseUrl: string): string {
    const normalizedApiBaseUrl = normalizeBaseUrl(apiBaseUrl);
    return [
        `RALLAR_API_BASE_URL=${normalizedApiBaseUrl}`,
        `RALLAR_WS_BASE_URL=${toWsBaseUrl(normalizedApiBaseUrl)}`
    ].join(' ');
}

function createFullStackSpaCorsOrigins(spaBaseUrl: string): string {
    const normalizedSpaBaseUrl = normalizeBaseUrl(spaBaseUrl);
    const url = new URL(normalizedSpaBaseUrl);
    const origins = [url.origin];
    if (url.hostname === 'localhost') {
        url.hostname = '127.0.0.1';
        origins.push(url.origin);
    }
    else if (url.hostname === '127.0.0.1') {
        url.hostname = 'localhost';
        origins.push(url.origin);
    }
    return origins.join(',');
}

function createMemoryApiCommand({ apiBaseUrl, spaBaseUrl, apiInvocation, iceRequests }: MemoryApiCommandInput): string {
    return `cd ../.. && CORS_ORIGINS=${createFullStackSpaCorsOrigins(spaBaseUrl)} PORT=${portFromBaseUrl(apiBaseUrl)} ${
        createFullStackApiUrlEnvBlock(apiBaseUrl)
    } ${createFullStackApiProfileEnvBlock()} RALLAR_ICE_RATE_LIMIT_REQUESTS=${iceRequests} ${apiInvocation} run --config apps/api-v1/deno.json --allow-net --allow-env --allow-read apps/api-v1/src/main.ts`;
}

function createPostgresApiCommand(apiBaseUrl: string, spaBaseUrl: string, apiInvocation: string): string {
    return `cd ../.. && ${REQUIRE_LAUNCHING_DATABASE_URL} && ${createFullStackApiProfileEnvBlock()} RALLAR_SQL_BACKEND=postgres RALLAR_PGLITE_SCHEMA_INIT=disabled RALLAR_DB_PUBSUB=postgres CORS_ORIGINS=${
        createFullStackSpaCorsOrigins(spaBaseUrl)
    } PORT=${portFromBaseUrl(apiBaseUrl)} ${
        createFullStackApiUrlEnvBlock(apiBaseUrl)
    } ${apiInvocation} run --config apps/api-v1/deno.json --allow-net --allow-env --allow-read apps/api-v1/src/main.ts`;
}

function toFullStackApiInvocation(
    directory: string | undefined,
    mode: FullStackApiServerMode,
    appInboxPhaseTiming: boolean
): string {
    if (directory === undefined) {
        return 'deno';
    }
    if (mode !== 'memory' || !path.isAbsolute(directory)) {
        throw new Error('Setup timing capture requires the local memory API and an absolute recorder directory.');
    }
    const quotedDirectory = '\'' + directory.replaceAll('\'', '\'\\\'\'') + '\'';
    return `RALLAR_TIMING_LOGS=true RALLAR_APP_INBOX_PHASE_TIMING=${appInboxPhaseTiming} node --import tsx apps/rallar-black-box/scripts/run-full-stack-api-with-timing.ts ${quotedDirectory} -- deno`;
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
    value: string
): value is FullStackApiServerMode {
    return FULL_STACK_API_SERVER_MODES.some((mode) => mode === value);
}
