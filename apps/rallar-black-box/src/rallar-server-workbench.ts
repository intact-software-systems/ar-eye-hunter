import type { AuthSession } from '@shared/api/api-config.ts';
import { DEFAULT_STATE_APPLICATION_ID, DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import type { RallarBlackBoxTestHttpRequestCommand } from '@shared-test/rallar-bb-test/types.ts';
import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';

export type RallarServerRestMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
export type RallarServerResponseBodyMode = 'auto' | 'json' | 'text' | 'none';

export type RallarServerEndpointPreset = Readonly<{
    presetId: string;
    tag: string;
    label: string;
    method: RallarServerRestMethod;
    pathTemplate: string;
    requiresAuth: boolean;
    body?: unknown;
    responseBodyMode?: RallarServerResponseBodyMode;
}>;

export type RallarServerEndpointDraft = Readonly<{
    method: RallarServerRestMethod;
    path: string;
    headersText: string;
    queryText: string;
    bodyText: string;
    responseBodyMode: RallarServerResponseBodyMode;
    attachAuth: boolean;
}>;

export type RallarServerRestRequestInput =
    & RallarServerEndpointDraft
    & Readonly<{
    apiBaseUrl: string;
    timeoutMs: number;
    authSession?: AuthSession;
    forbidPlaceholderBaseUrl?: boolean;
}>;

export type RallarServerRestRequest = Readonly<{
    url: string;
    method: RallarServerRestMethod;
    headers: Readonly<Record<string, string>>;
    bodyValue?: unknown;
    bodyText?: string;
    redactedHeaders: Readonly<Record<string, string>>;
}>;

export type RallarServerRestErrorKind =
    | 'unauthenticated'
    | 'forbidden'
    | 'timeout'
    | 'network-or-cors'
    | 'invalid-json'
    | 'http-error';

export type RallarServerRestResponse = Readonly<{
    ok: boolean;
    url: string;
    status: number;
    statusText: string;
    durationMs: number;
    headers: Readonly<Record<string, string>>;
    bodyText: string;
    bodyJson?: unknown;
    bodyKind: 'empty' | 'json' | 'text';
    error?: Readonly<{
        kind: RallarServerRestErrorKind;
        message: string;
    }>;
}>;

export type RallarServerWorkbenchVariables = Readonly<{
    applicationId: string;
    workspaceId: string;
    principalId: string;
    sessionId: string;
    clientInstanceId: string;
    groupId: string;
    username: string;
}>;

type OpenApiDocument = Readonly<{
    paths?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}>;

export const RALLAR_SERVER_ENDPOINT_PRESETS: readonly RallarServerEndpointPreset[] = [
    {
        presetId: 'config-read',
        tag: 'Config',
        label: 'Read runtime config',
        method: 'GET',
        pathTemplate: '/api/config',
        requiresAuth: false,
    },
    {
        presetId: 'auth-ws-ticket',
        tag: 'Auth',
        label: 'Create WS ticket',
        method: 'POST',
        pathTemplate: '/api/auth/ws-ticket',
        requiresAuth: true,
        body: {},
    },
    {
        presetId: 'webrtc-ice',
        tag: 'WebRTC',
        label: 'Read ICE servers',
        method: 'GET',
        pathTemplate: '/api/webrtc/ice',
        requiresAuth: true,
    },
    {
        presetId: 'clients-list',
        tag: 'Client State',
        label: 'List clients',
        method: 'GET',
        pathTemplate: '/api/state/apps/{applicationId}/workspaces/{workspaceId}/clients',
        requiresAuth: true,
    },
    {
        presetId: 'client-read',
        tag: 'Client State',
        label: 'Read current client',
        method: 'GET',
        pathTemplate: '/api/state/apps/{applicationId}/workspaces/{workspaceId}/clients/{principalId}',
        requiresAuth: true,
    },
    {
        presetId: 'client-presence',
        tag: 'Client State',
        label: 'Read current client presence',
        method: 'GET',
        pathTemplate: '/api/state/apps/{applicationId}/workspaces/{workspaceId}/clients/{principalId}/presence',
        requiresAuth: true,
    },
    {
        presetId: 'client-events',
        tag: 'Client State',
        label: 'List current client events',
        method: 'GET',
        pathTemplate: '/api/state/apps/{applicationId}/workspaces/{workspaceId}/clients/{principalId}/events',
        requiresAuth: true,
    },
    {
        presetId: 'client-principal-upsert',
        tag: 'Client State',
        label: 'Upsert current client principal',
        method: 'PUT',
        pathTemplate: '/api/state/apps/{applicationId}/workspaces/{workspaceId}/clients/{principalId}/principal',
        requiresAuth: true,
        body: {
            username: '{username}',
            displayName: '{username}',
            status: 'active',
        },
    },
    {
        presetId: 'client-instance-upsert',
        tag: 'Client State',
        label: 'Upsert current client instance',
        method: 'PUT',
        pathTemplate: '/api/state/apps/{applicationId}/workspaces/{workspaceId}/clients/{principalId}/instances/{clientInstanceId}',
        requiresAuth: true,
        body: {
            status: 'active',
            platform: 'browser',
            deviceLabel: 'rallar-black-box',
            capabilities: ['black-box-testing'],
        },
    },
    {
        presetId: 'client-session-connect',
        tag: 'Client State',
        label: 'Connect current client session',
        method: 'PUT',
        pathTemplate: '/api/state/apps/{applicationId}/workspaces/{workspaceId}/clients/{principalId}/instances/{clientInstanceId}/sessions/{sessionId}',
        requiresAuth: true,
        body: {
            presenceState: 'online',
            transport: 'rtc',
            connectionId: 'rallar-black-box',
        },
    },
    {
        presetId: 'client-session-heartbeat',
        tag: 'Client State',
        label: 'Heartbeat current client session',
        method: 'POST',
        pathTemplate: '/api/state/apps/{applicationId}/workspaces/{workspaceId}/clients/{principalId}/instances/{clientInstanceId}/sessions/{sessionId}/heartbeat',
        requiresAuth: true,
        body: {
            presenceState: 'online',
        },
    },
    {
        presetId: 'groups-list',
        tag: 'Group State',
        label: 'List groups',
        method: 'GET',
        pathTemplate: '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups',
        requiresAuth: true,
    },
    {
        presetId: 'group-create',
        tag: 'Group State',
        label: 'Create group',
        method: 'POST',
        pathTemplate: '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups',
        requiresAuth: true,
        body: {
            groupId: '{groupId}',
            displayName: '{groupId}',
            description: 'Created by rallar-black-box',
            kind: 'room',
            joinMode: 'open',
            createdByPrincipalId: '{principalId}',
            metadata: {
                source: 'rallar-black-box',
            },
        },
    },
    {
        presetId: 'group-read',
        tag: 'Group State',
        label: 'Read group',
        method: 'GET',
        pathTemplate: '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}',
        requiresAuth: true,
    },
    {
        presetId: 'group-member-join',
        tag: 'Group State',
        label: 'Join group',
        method: 'PUT',
        pathTemplate: '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/members/{principalId}',
        requiresAuth: true,
        body: {
            status: 'active',
        },
    },
    {
        presetId: 'group-presence-connect',
        tag: 'Group State',
        label: 'Connect group presence',
        method: 'PUT',
        pathTemplate: '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/sessions/{sessionId}',
        requiresAuth: true,
        body: {
            principalId: '{principalId}',
        },
    },
    {
        presetId: 'group-presence-heartbeat',
        tag: 'Group State',
        label: 'Heartbeat group presence',
        method: 'POST',
        pathTemplate: '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/sessions/{sessionId}/heartbeat',
        requiresAuth: true,
        body: {
            principalId: '{principalId}',
        },
    },
    {
        presetId: 'group-presence-disconnect',
        tag: 'Group State',
        label: 'Disconnect group presence',
        method: 'POST',
        pathTemplate: '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/sessions/{sessionId}/disconnect',
        requiresAuth: true,
        body: {
            principalId: '{principalId}',
        },
    },
    {
        presetId: 'group-events',
        tag: 'Group State',
        label: 'List group events',
        method: 'GET',
        pathTemplate: '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/events',
        requiresAuth: true,
    },
    {
        presetId: 'graph-global',
        tag: 'Graph',
        label: 'Read global graph',
        method: 'GET',
        pathTemplate: '/api/graph',
        requiresAuth: false,
    },
    {
        presetId: 'graph-group',
        tag: 'Graph',
        label: 'Read group graph',
        method: 'GET',
        pathTemplate: '/api/graph/tree/{groupId}',
        requiresAuth: false,
    },
    {
        presetId: 'openapi-json',
        tag: 'Docs',
        label: 'Read OpenAPI JSON',
        method: 'GET',
        pathTemplate: '/api/openapi.json',
        requiresAuth: false,
    },
];

export function defaultRallarServerWorkbenchVariables(input: Partial<RallarServerWorkbenchVariables>): RallarServerWorkbenchVariables {
    const principalId = input.principalId || 'alice';
    const sessionId = input.sessionId || 'visible-session-alice';

    return {
        applicationId: input.applicationId || DEFAULT_STATE_APPLICATION_ID,
        workspaceId: input.workspaceId || DEFAULT_STATE_WORKSPACE_ID,
        principalId,
        sessionId,
        clientInstanceId: input.clientInstanceId || `${sessionId}-browser`,
        groupId: input.groupId || 'rallar-black-box-room',
        username: input.username || principalId,
    };
}

export function applyRallarServerEndpointPreset(
    preset: RallarServerEndpointPreset,
    variables: RallarServerWorkbenchVariables,
): RallarServerEndpointDraft {
    return {
        method: preset.method,
        path: resolveRallarServerPathTemplate(preset.pathTemplate, variables),
        headersText: '{}',
        queryText: '{}',
        bodyText: preset.body === undefined
            ? ''
            : resolveRallarServerBodyTemplate(preset.body, variables),
        responseBodyMode: preset.responseBodyMode ?? 'auto',
        attachAuth: preset.requiresAuth,
    };
}

export function resolveRallarServerPathTemplate(
    template: string,
    variables: RallarServerWorkbenchVariables,
): string {
    return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_, key: keyof RallarServerWorkbenchVariables) =>
        encodeURIComponent(variables[key] ?? `{${String(key)}}`)
    );
}

export function resolveRallarServerBodyTemplate(
    body: unknown,
    variables: RallarServerWorkbenchVariables,
): string {
    const template = JSON.stringify(body, null, 2);
    return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_, key: keyof RallarServerWorkbenchVariables) =>
        variables[key] ?? `{${String(key)}}`
    );
}

export function buildRallarServerRestRequest(input: RallarServerRestRequestInput): RallarServerRestRequest {
    const baseUrl = normalizeRallarServerBaseUrl(input.apiBaseUrl, input.forbidPlaceholderBaseUrl);
    const query = parseOptionalJsonRecord(input.queryText, 'Query JSON');
    const customHeaders = parseStringRecord(input.headersText, 'Headers JSON');
    const url = toRallarServerRequestUrl(baseUrl, input.path, query);
    const bodyValue = input.bodyText.trim().length === 0 || input.method === 'GET'
        ? undefined
        : parseOptionalJsonValue(input.bodyText, 'Body JSON');
    const headers: Record<string, string> = {
        accept: 'application/json',
        ...customHeaders,
    };

    if (bodyValue !== undefined && !hasHeader(headers, 'content-type')) {
        headers['content-type'] = 'application/json';
    }

    if (input.attachAuth) {
        if (!input.authSession) {
            throw new Error('Rallar Server request requires a browser auth session.');
        }
        headers.authorization = `Bearer ${input.authSession.accessToken}`;
        headers['x-client-id'] = input.authSession.clientId;
    }

    return {
        url,
        method: input.method,
        headers,
        bodyValue,
        bodyText: bodyValue === undefined
            ? undefined
            : typeof bodyValue === 'string'
                ? bodyValue
                : JSON.stringify(bodyValue),
        redactedHeaders: redactRallarServerValue(headers, input.authSession),
    };
}

export async function executeRallarServerRestRequest(
    input: RallarServerRestRequestInput,
    fetchImpl: typeof fetch = fetch,
): Promise<RallarServerRestResponse> {
    const request = buildRallarServerRestRequest(input);
    const controller = new AbortController();
    const startedAt = Date.now();
    const timeout = Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
        ? setTimeout(() => controller.abort(), input.timeoutMs)
        : undefined;

    try {
        const response = await fetchImpl(request.url, {
            method: request.method,
            headers: request.headers,
            body: request.bodyText,
            signal: controller.signal,
        });
        const durationMs = Date.now() - startedAt;
        const headers = toHeadersRecord(response.headers);
        const bodyText = input.responseBodyMode === 'none'
            ? ''
            : await response.text();
        const parsed = parseResponseBody(bodyText, headers, input.responseBodyMode);
        const error = parsed.error ??
            (response.ok
                ? undefined
                : {
                    kind: classifyHttpStatus(response.status),
                    message: `HTTP ${response.status} ${response.statusText}`,
                });

        return {
            ok: response.ok && !error,
            url: response.url || request.url,
            status: response.status,
            statusText: response.statusText,
            durationMs,
            headers,
            bodyText,
            bodyJson: parsed.bodyJson,
            bodyKind: parsed.bodyKind,
            error,
        };
    } catch (error) {
        const durationMs = Date.now() - startedAt;
        return {
            ok: false,
            url: request.url,
            status: 0,
            statusText: 'Fetch failed',
            durationMs,
            headers: {},
            bodyText: '',
            bodyKind: 'empty',
            error: classifyFetchError(error),
        };
    } finally {
        if (timeout !== undefined) {
            clearTimeout(timeout);
        }
    }
}

export function toRallarServerBlackBoxCommand(
    input: RallarServerRestRequestInput,
    commandId = `rallar-server-${input.method.toLowerCase()}-${Date.now()}`,
): RallarBlackBoxTestHttpRequestCommand {
    const query = parseOptionalJsonRecord(input.queryText, 'Query JSON');
    const headers = parseStringRecord(input.headersText, 'Headers JSON');
    const bodyValue = input.bodyText.trim().length === 0 || input.method === 'GET'
        ? undefined
        : parseOptionalJsonValue(input.bodyText, 'Body JSON');
    const path = withQueryString(normalizePath(input.path), query);

    return {
        kind: 'http.request',
        commandId,
        request: {
            path,
            method: input.method,
            ...(Object.keys(headers).length > 0 ? { headers } : {}),
            ...(bodyValue === undefined ? {} : { body: bodyValue }),
        },
        response: {
            body: input.responseBodyMode === 'none'
                ? 'none'
                : input.responseBodyMode === 'text'
                    ? 'text'
                    : 'json',
        },
    };
}

export function toRallarServerCurl(
    input: RallarServerRestRequestInput,
): string {
    const request = buildRallarServerRestRequest(input);
    const redactedBodyText = request.bodyText
        ? redactRallarServerText(request.bodyText, input.authSession)
        : undefined;
    const lines = [
        'curl',
        '-X',
        request.method,
        quoteShell(redactRallarServerUrl(request.url, input.authSession)),
        ...Object.entries(request.redactedHeaders)
            .map(([key, value]) => ['-H', quoteShell(`${key}: ${value}`)])
            .flat(),
        ...(redactedBodyText
            ? ['--data', quoteShell(redactedBodyText)]
            : []),
    ];

    return lines.join(' ');
}

export function redactRallarServerValue<T>(value: T, authSession?: AuthSession): T {
    return redactRallarBlackBoxValue(value, {
        secretValues: [
            authSession?.accessToken,
            authSession ? `Bearer ${authSession.accessToken}` : undefined,
        ].filter((entry): entry is string => Boolean(entry)),
    });
}

export function redactRallarServerText(text: string, authSession?: AuthSession): string {
    const trimmed = text.trim();
    if (!trimmed) {
        return text;
    }

    try {
        return JSON.stringify(
            redactRallarServerValue(JSON.parse(trimmed) as unknown, authSession),
            null,
            2,
        );
    } catch {
        return redactRallarServerValue(text, authSession);
    }
}

export function redactRallarServerUrl(url: string, authSession?: AuthSession): string {
    try {
        const parsed = new URL(url);
        for (const [key, value] of [...parsed.searchParams.entries()]) {
            const redacted = redactRallarServerValue({ [key]: value }, authSession) as Record<string, string>;
            if (redacted[key] !== value) {
                parsed.searchParams.set(key, redacted[key]);
            }
        }
        return parsed.toString();
    } catch {
        return redactRallarServerValue(url, authSession);
    }
}

export function extractRallarServerOpenApiEndpoints(
    openApi: OpenApiDocument,
): readonly RallarServerEndpointPreset[] {
    const paths = openApi.paths ?? {};

    return Object.entries(paths).flatMap(([pathTemplate, operations]) =>
        Object.entries(operations)
            .filter(([method]) => isRallarServerRestMethod(method.toUpperCase()))
            .map(([method, operation]) => {
                const operationRecord = operation && typeof operation === 'object'
                    ? operation as Record<string, unknown>
                    : {};
                const summary = typeof operationRecord.summary === 'string'
                    ? operationRecord.summary
                    : `${method.toUpperCase()} ${pathTemplate}`;
                const tags = Array.isArray(operationRecord.tags)
                    ? operationRecord.tags.filter((tag): tag is string => typeof tag === 'string')
                    : [];

                return {
                    presetId: `openapi-${method}-${pathTemplate.replace(/[^A-Za-z0-9]+/g, '-')}`,
                    tag: tags[0] ?? 'OpenAPI',
                    label: summary,
                    method: method.toUpperCase() as RallarServerRestMethod,
                    pathTemplate,
                    requiresAuth: Array.isArray(operationRecord.security),
                };
            })
    );
}

export async function fetchRallarServerOpenApiEndpoints(
    apiBaseUrl: string,
    fetchImpl: typeof fetch = fetch,
): Promise<readonly RallarServerEndpointPreset[]> {
    const baseUrl = normalizeRallarServerBaseUrl(apiBaseUrl, false);
    const response = await fetchImpl(new URL('/api/openapi.json', baseUrl).toString());
    if (!response.ok) {
        throw new Error(`OpenAPI request failed: ${response.status}`);
    }

    return extractRallarServerOpenApiEndpoints(await response.json() as OpenApiDocument);
}

function normalizeRallarServerBaseUrl(
    apiBaseUrl: string,
    forbidPlaceholderBaseUrl?: boolean,
): string {
    const trimmed = apiBaseUrl.trim();
    if (!trimmed) {
        throw new Error('Rallar Server API base URL is required.');
    }
    if (forbidPlaceholderBaseUrl && /api\.example\.invalid/i.test(trimmed)) {
        throw new Error('Real-provider Rallar Server requests cannot use the placeholder API base URL.');
    }

    return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function toRallarServerRequestUrl(
    apiBaseUrl: string,
    path: string,
    query: Readonly<Record<string, unknown>>,
): string {
    return withQueryString(new URL(normalizePath(path), apiBaseUrl).toString(), query);
}

function normalizePath(path: string): string {
    const trimmed = path.trim();
    if (!trimmed) {
        throw new Error('Rallar Server request path is required.');
    }

    return /^https?:\/\//i.test(trimmed) || trimmed.startsWith('/')
        ? trimmed
        : `/${trimmed}`;
}

function withQueryString(
    pathOrUrl: string,
    query: Readonly<Record<string, unknown>>,
): string {
    const url = /^https?:\/\//i.test(pathOrUrl)
        ? new URL(pathOrUrl)
        : new URL(pathOrUrl, 'http://rallar-black-box.local');

    for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') {
            continue;
        }
        if (Array.isArray(value)) {
            for (const item of value) {
                url.searchParams.append(key, String(item));
            }
            continue;
        }
        url.searchParams.set(key, String(value));
    }

    return /^https?:\/\//i.test(pathOrUrl)
        ? url.toString()
        : `${url.pathname}${url.search}`;
}

function parseOptionalJsonRecord(
    text: string,
    label: string,
): Readonly<Record<string, unknown>> {
    const value = parseOptionalJsonValue(text, label);
    if (value === undefined) {
        return {};
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be a JSON object.`);
    }

    return value as Record<string, unknown>;
}

function parseStringRecord(
    text: string,
    label: string,
): Readonly<Record<string, string>> {
    const record = parseOptionalJsonRecord(text, label);
    return Object.fromEntries(
        Object.entries(record).map(([key, value]) => {
            if (
                value === undefined ||
                value === null ||
                typeof value === 'object'
            ) {
                throw new Error(`${label} value for ${key} must be a scalar.`);
            }

            return [key, String(value)];
        }),
    );
}

function parseOptionalJsonValue(text: string, label: string): unknown | undefined {
    const trimmed = text.trim();
    if (!trimmed) {
        return undefined;
    }

    try {
        return JSON.parse(trimmed) as unknown;
    } catch (error) {
        throw new Error(`${label} is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function hasHeader(headers: Readonly<Record<string, string>>, expected: string): boolean {
    const lowerExpected = expected.toLowerCase();
    return Object.keys(headers).some(key => key.toLowerCase() === lowerExpected);
}

function toHeadersRecord(headers: Headers): Readonly<Record<string, string>> {
    const record: Record<string, string> = {};
    headers.forEach((value, key) => {
        record[key] = value;
    });
    return record;
}

function parseResponseBody(
    bodyText: string,
    headers: Readonly<Record<string, string>>,
    mode: RallarServerResponseBodyMode,
): Pick<RallarServerRestResponse, 'bodyKind' | 'bodyJson' | 'error'> {
    if (!bodyText) {
        return { bodyKind: 'empty' };
    }

    const contentType = headers['content-type'] ?? headers['Content-Type'] ?? '';
    const shouldParseJson = mode === 'json' || (mode === 'auto' && contentType.includes('json'));
    if (!shouldParseJson) {
        return { bodyKind: 'text' };
    }

    try {
        return {
            bodyKind: 'json',
            bodyJson: JSON.parse(bodyText) as unknown,
        };
    } catch (error) {
        return {
            bodyKind: 'text',
            error: {
                kind: 'invalid-json',
                message: `Response JSON is invalid: ${error instanceof Error ? error.message : String(error)}`,
            },
        };
    }
}

function classifyHttpStatus(status: number): RallarServerRestErrorKind {
    if (status === 401) {
        return 'unauthenticated';
    }
    if (status === 403) {
        return 'forbidden';
    }
    return 'http-error';
}

function classifyFetchError(error: unknown): RallarServerRestResponse['error'] {
    if (error instanceof DOMException && error.name === 'AbortError') {
        return {
            kind: 'timeout',
            message: 'Rallar Server request timed out.',
        };
    }

    return {
        kind: 'network-or-cors',
        message: error instanceof Error ? error.message : String(error),
    };
}

function isRallarServerRestMethod(value: string): boolean {
    return value === 'GET' || value === 'POST' || value === 'PUT' || value === 'DELETE';
}

function quoteShell(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}
