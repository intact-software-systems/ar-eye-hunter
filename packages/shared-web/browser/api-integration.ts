import { Temporal } from '@js-temporal/polyfill';
import { readApiBaseUrl } from './api-client-config.ts';
import { readSession } from '@shared/api/auth.ts';
import {
    AgentSessionTicketRequest,
    AgentSessionTicketResponse,
    ApiConfig,
    type AuthSession,
    ConsumeAgentSessionTicketRequest,
    ConsumeAgentSessionTicketResponse,
    IceConfig,
    LoginRequest,
    LoginResponse,
    LogoutResponse,
    RegisterRequest,
    RegisterResponse,
    WebSocketTicketResponse,
} from '@shared/api/api-config.ts';
import type {
    ClientEvent,
    ClientEventType,
    ClientSnapshot as ClientStateSnapshot,
} from '@shared/api/client-types.ts';
import type {
    GroupEvent,
    GroupEventType,
    GroupSnapshot as GroupStateSnapshot,
} from '@shared/api/group-types.ts';
import type {
    GroupSpaStatisticsResponse,
    MyRealtimeSpaStatisticsResponse,
    WorkspaceSpaStatisticsResponse,
} from '@shared/api/spa-statistics-types.ts';
import type {
    GraphDiagnosticReadOptions,
    GraphDiagnosticReadResponse,
    GroupTopologyConfigView,
    GroupTopologyManagementView,
    PutGroupTopologyConfigRequest,
    PutGroupTopologyOverrideRequest,
    ReconfigureGroupTopologyRequest,
    ReconfigureGroupTopologyResponse,
    StoredGroupTopologyConfig,
    StoredGroupTopologyOverride,
} from '@shared/api/graph-topology-management-types.ts';
import {
    type AcceptGroupInviteRequest,
    type AppointGroupDirectorRequest,
    type BanGroupMemberRequest,
    type ConnectClientSessionRequest,
    type ConnectGroupPresenceSessionRequest,
    type CreateGroupInviteRequest,
    type CreateGroupRequest,
    DEFAULT_STATE_APPLICATION_ID,
    DEFAULT_STATE_WORKSPACE_ID,
    type DisconnectGroupPresenceSessionRequest,
    type HeartbeatClientSessionRequest,
    type HeartbeatGroupPresenceSessionRequest,
    type JoinGroupRequest,
    type RemoveGroupMemberRequest,
    type RevokeGroupInviteRequest,
    type RotateGroupJoinCodeRequest,
    type SetGroupMemberRoleRequest,
    type StateScope,
    type StateErrorResponse,
    type TransferGroupOwnershipRequest,
    type UnbanGroupMemberRequest,
    type UpdateGroupRequest,
    type UpsertGroupMemberRequest,
    type GroupJoinCodeResponse,
} from '@shared/api/state-types.ts';
import type {
    StateEventCursor,
    StateEventPage,
} from '@shared/api/state-event-types.ts';
import type {
    RallarCrdtCatchUpRequestEnvelope,
    RallarCrdtCatchUpResponseEnvelope,
} from '@shared/crdt/mod.ts';
import {
    CircuitBreaker,
    CircuitBreakerPolicy,
    RateLimiter,
} from '@shared/resilience/Resilience.ts';

export type ApiRequestOptions = Readonly<{
    signal?: AbortSignal;
    authSession?: AuthSession | null;
}>;

export type ApiHttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export type StateEventListRequestOptions<TEventType extends string> =
    & ApiRequestOptions
    & Readonly<{
    eventTypes?: readonly TEventType[];
    limit?: number;
    after?: StateEventCursor;
}>;

export type StateGraphDiagnosticReadOptions =
    & ApiRequestOptions
    & GraphDiagnosticReadOptions;

export type StateGroupTopologyDeleteOptions =
    & ApiRequestOptions
    & Readonly<{
    reconfigure?: boolean;
}>;

export type PutStateGroupTopologyConfigResponse = Readonly<{
    config: StoredGroupTopologyConfig;
    reconfigure?: ReconfigureGroupTopologyResponse;
}>;

export type PutStateGroupTopologyOverrideResponse = Readonly<{
    override: StoredGroupTopologyOverride;
    reconfigure?: ReconfigureGroupTopologyResponse;
}>;

export type DeleteStateGroupTopologyConfigResponse = Readonly<{
    deleted: boolean;
    reconfigure?: ReconfigureGroupTopologyResponse;
}>;

export type GroupStateEventListRequestOptions =
    StateEventListRequestOptions<GroupEventType>;

export type ClientStateEventListRequestOptions =
    StateEventListRequestOptions<ClientEventType>;

export class ApiHttpError extends Error {
    public readonly policyError?: StateErrorResponse & Readonly<{ code: string }>;

    public constructor(
        public readonly method: ApiHttpMethod,
        public readonly path: string,
        public readonly status: number,
        public readonly bodyText: string,
        public readonly headers?: Headers,
    ) {
        super(`API ${method} ${path} failed: ${status} ${bodyText}`);
        this.name = 'ApiHttpError';
        this.policyError = parseApiPolicyError(bodyText);
    }
}

export function readApiPolicyError(
    error: unknown,
): (StateErrorResponse & Readonly<{ code: string }>) | undefined {
    if (error instanceof ApiHttpError) {
        return error.policyError;
    }

    return undefined;
}

export type WebSocketTicketBackoffState = Readonly<
    | {
        status: 'idle';
        lastStatus?: number;
        lastFailureAtEpochMs?: number;
    }
    | {
        status: 'cooldown';
        retryAtEpochMs: number;
        lastStatus: number;
        lastFailureAtEpochMs: number;
        reason: string;
    }
    | {
        status: 'local-rate-limited';
        lastStatus: number;
        lastFailureAtEpochMs: number;
        reason: string;
    }
    | {
        status: 'circuit-open';
        lastStatus: number;
        lastFailureAtEpochMs: number;
        reason: string;
    }
>;

export type WebSocketTicketLocalRateLimitConfig = Readonly<{
    windowMs: number;
    maxRequests: number;
}>;

export type WebSocketTicketCircuitBreakerConfig = Readonly<{
    maxConsecutiveFailures: number;
    resetTimeoutMs: number;
    halfOpenTimeoutMs: number;
    slidingWindowMs: number;
}>;

const DEFAULT_WS_TICKET_429_BACKOFF_MS = 5_000;
const DEFAULT_WS_TICKET_LOCAL_RATE_LIMIT: WebSocketTicketLocalRateLimitConfig = {
    windowMs: 60_000,
    maxRequests: 30,
};
const DEFAULT_WS_TICKET_CIRCUIT_BREAKER: WebSocketTicketCircuitBreakerConfig = {
    maxConsecutiveFailures: 2,
    resetTimeoutMs: 10_000,
    halfOpenTimeoutMs: 10_000,
    slidingWindowMs: 10_000,
};
const WS_TICKET_LOCAL_RATE_LIMIT_REASON =
    'WebSocket ticket request suppressed by local client rate limiter.';
const WS_TICKET_CIRCUIT_OPEN_REASON =
    'WebSocket ticket request suppressed by local circuit breaker.';

let webSocketTicketBackoffState: WebSocketTicketBackoffState = {
    status: 'idle',
};
let webSocketTicketLocalRateLimitConfig = DEFAULT_WS_TICKET_LOCAL_RATE_LIMIT;
const webSocketTicketLocalLimiters = new Map<string, RateLimiter>();
let webSocketTicketCircuitBreakerConfig = DEFAULT_WS_TICKET_CIRCUIT_BREAKER;
let webSocketTicketCircuitBreaker = createWebSocketTicketCircuitBreaker(
    webSocketTicketCircuitBreakerConfig,
);

type WebSocketTicketAttempt = Readonly<
    | {
        kind: 'ok';
        ticket: WebSocketTicketResponse;
    }
    | {
        kind: 'http-error';
        error: ApiHttpError;
    }
    | {
        kind: 'error';
        error: Error;
    }
>;

export function readWebSocketTicketBackoffState(): WebSocketTicketBackoffState {
    return webSocketTicketBackoffState;
}

export function resetWebSocketTicketBackoff(): void {
    webSocketTicketBackoffState = { status: 'idle' };
    webSocketTicketLocalLimiters.clear();
    webSocketTicketCircuitBreaker = createWebSocketTicketCircuitBreaker(
        webSocketTicketCircuitBreakerConfig,
    );
}

export function configureWebSocketTicketLocalRateLimit(
    config: WebSocketTicketLocalRateLimitConfig,
): void {
    webSocketTicketLocalRateLimitConfig = config;
    webSocketTicketLocalLimiters.clear();
}

export function configureWebSocketTicketCircuitBreaker(
    config: WebSocketTicketCircuitBreakerConfig,
): void {
    webSocketTicketCircuitBreakerConfig = config;
    webSocketTicketCircuitBreaker = createWebSocketTicketCircuitBreaker(config);
}

function createWebSocketTicketCircuitBreaker(
    config: WebSocketTicketCircuitBreakerConfig,
): CircuitBreaker {
    return CircuitBreaker.create(new CircuitBreakerPolicy(
        config.maxConsecutiveFailures,
        Temporal.Duration.from({ milliseconds: config.resetTimeoutMs }),
        Temporal.Duration.from({ milliseconds: config.halfOpenTimeoutMs }),
        Temporal.Duration.from({ milliseconds: config.slidingWindowMs }),
    ));
}

function readWebSocketTicketLocalLimiter(sessionId: string): RateLimiter {
    const existing = webSocketTicketLocalLimiters.get(sessionId);
    if (existing) {
        return existing;
    }

    const limiter = RateLimiter.init(
        webSocketTicketLocalRateLimitConfig.windowMs,
        webSocketTicketLocalRateLimitConfig.maxRequests,
    );
    webSocketTicketLocalLimiters.set(sessionId, limiter);
    return limiter;
}

function readRetryAfterMs(headers: Headers | undefined, nowMs: number): number {
    const raw = headers?.get('retry-after');
    if (!raw) {
        return DEFAULT_WS_TICKET_429_BACKOFF_MS;
    }

    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.max(0, seconds * 1_000);
    }

    const retryAt = Date.parse(raw);
    if (Number.isFinite(retryAt)) {
        return Math.max(0, retryAt - nowMs);
    }

    return DEFAULT_WS_TICKET_429_BACKOFF_MS;
}

async function executeWebSocketTicketAttempt(
    options?: ApiRequestOptions,
): Promise<WebSocketTicketAttempt> {
    try {
        return {
            kind: 'ok',
            ticket: await executeHttpRequest<
                Record<string, never>,
                WebSocketTicketResponse
            >(
                readApiBaseUrl(),
                '/api/auth/ws-ticket',
                'POST',
                {},
                options,
            ),
        };
    } catch (error) {
        if (error instanceof ApiHttpError) {
            return { kind: 'http-error', error };
        }
        return {
            kind: 'error',
            error: error instanceof Error ? error : new Error(String(error)),
        };
    }
}

function isSuccessfulWebSocketTicketAttempt(
    attempt: WebSocketTicketAttempt,
): boolean {
    if (attempt.kind === 'ok') {
        return true;
    }
    if (attempt.kind === 'http-error') {
        return attempt.error.status < 500;
    }
    return attempt.error.name === 'AbortError';
}

function throwWebSocketTicketAttempt(attempt: WebSocketTicketAttempt): never {
    if (attempt.kind === 'ok') {
        throw new Error('Cannot throw a successful WebSocket ticket attempt.');
    }
    throw attempt.error;
}

function readWebSocketTicketAttemptStatus(attempt: WebSocketTicketAttempt): number {
    return attempt.kind === 'http-error' ? attempt.error.status : 503;
}

function markWebSocketTicketCircuitOpen(lastStatus: number = 503): void {
    webSocketTicketBackoffState = {
        status: 'circuit-open',
        lastStatus,
        lastFailureAtEpochMs: Date.now(),
        reason: WS_TICKET_CIRCUIT_OPEN_REASON,
    };
}

async function rejectWebSocketTicketLocalRateLimit(): Promise<WebSocketTicketResponse> {
    webSocketTicketBackoffState = {
        status: 'local-rate-limited',
        lastStatus: 429,
        lastFailureAtEpochMs: Date.now(),
        reason: WS_TICKET_LOCAL_RATE_LIMIT_REASON,
    };
    throw new ApiHttpError(
        'POST',
        '/api/auth/ws-ticket',
        429,
        WS_TICKET_LOCAL_RATE_LIMIT_REASON,
    );
}

async function createWebSocketTicketThroughCircuitBreaker(
    options?: ApiRequestOptions,
): Promise<WebSocketTicketResponse> {
    const result = await CircuitBreaker.tryToExecute<WebSocketTicketAttempt>(
        webSocketTicketCircuitBreaker,
        () => executeWebSocketTicketAttempt(options),
        isSuccessfulWebSocketTicketAttempt,
    );

    return result.fold(
        () => {
            markWebSocketTicketCircuitOpen();
            throw new ApiHttpError(
                'POST',
                '/api/auth/ws-ticket',
                503,
                WS_TICKET_CIRCUIT_OPEN_REASON,
            );
        },
        (attempt) => {
            if (attempt.kind === 'ok') {
                return attempt.ticket;
            }
            if (
                !isSuccessfulWebSocketTicketAttempt(attempt) &&
                webSocketTicketCircuitBreaker.isOpen()
            ) {
                markWebSocketTicketCircuitOpen(
                    readWebSocketTicketAttemptStatus(attempt),
                );
            }
            throwWebSocketTicketAttempt(attempt);
        },
    );
}

async function readTextOrElse(
    res: Response,
    orElse: () => string,
): Promise<string> {
    try {
        return await res.text();
    } catch {
        return orElse();
    }
}

function parseApiPolicyError(
    bodyText: string,
): (StateErrorResponse & Readonly<{ code: string }>) | undefined {
    try {
        const value = JSON.parse(bodyText);
        if (!isRecord(value)) {
            return undefined;
        }
        if (typeof value.error !== 'string' || typeof value.code !== 'string') {
            return undefined;
        }

        return {
            error: value.error,
            code: value.code,
            message: typeof value.message === 'string' ? value.message : undefined,
            details: isRecord(value.details) ? value.details : undefined,
        };
    } catch {
        return undefined;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

async function executeHttpRequest<TReq, TRes>(
    baseUrl: string,
    path: string,
    method: ApiHttpMethod,
    body: TReq | undefined,
    options: ApiRequestOptions = {},
): Promise<TRes> {
    const url = `${baseUrl}${path}`;

    const init: RequestInit = {
        method,
        headers: { 'content-type': 'application/json' },
        signal: options.signal,
    };

    const session = options.authSession === undefined
        ? readSession()
        : options.authSession;

    if (session) {
        const headers = new Headers(init.headers);
        headers.set('authorization', `Bearer ${session.accessToken}`);
        headers.set('x-client-id', session.clientId);
        init.headers = headers;
    }

    if (method === 'POST' || method === 'PUT') {
        if (body === undefined) {
            throw new Error(`${method} ${path} requires a body`);
        }
        init.body = JSON.stringify(body);
    } else if (method === 'DELETE' && body !== undefined) {
        init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);

    if (!res.ok) {
        const txt = await readTextOrElse(res, () => '');

        throw new ApiHttpError(method, path, res.status, txt, res.headers);
    }

    return (await res.json()) as TRes;
}

export async function readApiConfig(
    options?: ApiRequestOptions,
): Promise<ApiConfig> {
    return await executeHttpRequest<void, ApiConfig>(
        readApiBaseUrl(),
        '/api/config',
        'GET',
        undefined,
        options,
    );
}

export async function loginToApi(
    req: LoginRequest,
    options?: ApiRequestOptions,
): Promise<LoginResponse> {
    return await executeHttpRequest<LoginRequest, LoginResponse>(
        readApiBaseUrl(),
        '/api/auth/login',
        'POST',
        req,
        options,
    );
}

export async function registerWithApi(
    req: RegisterRequest,
    options?: ApiRequestOptions,
): Promise<RegisterResponse> {
    return await executeHttpRequest<RegisterRequest, RegisterResponse>(
        readApiBaseUrl(),
        '/api/auth/register',
        'POST',
        req,
        options,
    );
}

export async function logoutFromApi(
    options?: ApiRequestOptions,
): Promise<LogoutResponse> {
    return await executeHttpRequest<Record<string, never>, LogoutResponse>(
        readApiBaseUrl(),
        '/api/auth/logout',
        'POST',
        {},
        options,
    );
}

export async function issueAgentSessionTickets(
    request: AgentSessionTicketRequest,
    options?: ApiRequestOptions,
): Promise<AgentSessionTicketResponse> {
    return await issueAgentSessionTicketsAt(readApiBaseUrl(), request, options);
}

export async function issueAgentSessionTicketsAt(
    apiBaseUrl: string,
    request: AgentSessionTicketRequest,
    options?: ApiRequestOptions,
): Promise<AgentSessionTicketResponse> {
    return await executeHttpRequest<AgentSessionTicketRequest, AgentSessionTicketResponse>(
        normalizedExplicitApiBaseUrl(apiBaseUrl),
        '/api/auth/agent-session-tickets',
        'POST',
        request,
        options,
    );
}

export async function consumeAgentSessionTicket(
    request: ConsumeAgentSessionTicketRequest,
    options?: ApiRequestOptions,
): Promise<ConsumeAgentSessionTicketResponse> {
    return await consumeAgentSessionTicketAt(readApiBaseUrl(), request, options);
}

export async function consumeAgentSessionTicketAt(
    apiBaseUrl: string,
    request: ConsumeAgentSessionTicketRequest,
    options?: ApiRequestOptions,
): Promise<ConsumeAgentSessionTicketResponse> {
    return await executeHttpRequest<ConsumeAgentSessionTicketRequest, ConsumeAgentSessionTicketResponse>(
        normalizedExplicitApiBaseUrl(apiBaseUrl),
        '/api/auth/agent-session-tickets/consume',
        'POST',
        request,
        options,
    );
}

function normalizedExplicitApiBaseUrl(value: string): string {
    return value.trim().replace(/\/+$/, '');
}

export async function createWebSocketTicket(
    options?: ApiRequestOptions,
): Promise<WebSocketTicketResponse> {
    const now = Date.now();
    if (
        webSocketTicketBackoffState.status === 'cooldown' &&
        webSocketTicketBackoffState.retryAtEpochMs > now
    ) {
        throw new ApiHttpError(
            'POST',
            '/api/auth/ws-ticket',
            429,
            'WebSocket ticket request suppressed until cooldown expires.',
        );
    }
    if (!webSocketTicketCircuitBreaker.isAllowedThrough()) {
        markWebSocketTicketCircuitOpen();
        throw new ApiHttpError(
            'POST',
            '/api/auth/ws-ticket',
            503,
            WS_TICKET_CIRCUIT_OPEN_REASON,
        );
    }

    try {
        const session = options?.authSession === undefined
            ? readSession()
            : options.authSession;
        const limiterKey = session?.sessionId ?? 'anonymous';
        const ticket = await RateLimiter.tryToExecuteOrElse<WebSocketTicketResponse>(
            readWebSocketTicketLocalLimiter(limiterKey),
            () => createWebSocketTicketThroughCircuitBreaker(options),
            rejectWebSocketTicketLocalRateLimit,
        );
        webSocketTicketBackoffState = { status: 'idle' };
        return ticket;
    } catch (error) {
        if (
            error instanceof ApiHttpError &&
            error.status === 429 &&
            error.bodyText !== WS_TICKET_LOCAL_RATE_LIMIT_REASON
        ) {
            const failedAt = Date.now();
            webSocketTicketBackoffState = {
                status: 'cooldown',
                retryAtEpochMs: failedAt + readRetryAfterMs(error.headers, failedAt),
                lastStatus: 429,
                lastFailureAtEpochMs: failedAt,
                reason: error.bodyText,
            };
        }
        throw error;
    }
}

export async function readIceCandidates(
    options?: ApiRequestOptions,
): Promise<IceConfig> {
    return await executeHttpRequest<void, IceConfig>(
        readApiBaseUrl(),
        '/api/webrtc/ice',
        'GET',
        undefined,
        options,
    );
}

export async function catchUpRallarCrdtDocument(
    request: RallarCrdtCatchUpRequestEnvelope,
    options?: ApiRequestOptions,
): Promise<RallarCrdtCatchUpResponseEnvelope> {
    const response = await executeHttpRequest<
        RallarCrdtCatchUpRequestEnvelope,
        ApiResultEnvelope<RallarCrdtCatchUpResponseEnvelope>
    >(readApiBaseUrl(), '/api/crdt/catch-up', 'POST', request, options);

    if (!response.ok) {
        throw new Error(response.error);
    }

    return response.result;
}

export function defaultStateScope(): StateScope {
    return {
        applicationId: DEFAULT_STATE_APPLICATION_ID,
        workspaceId: DEFAULT_STATE_WORKSPACE_ID,
    };
}

type ApiResultEnvelope<T> =
    | Readonly<{
          ok: true;
          result: T;
      }>
    | Readonly<{
          ok: false;
          error: string;
      }>;

export async function listStateClients(
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<ClientStateSnapshot[]> {
    return await executeHttpRequest<void, ClientStateSnapshot[]>(
        readApiBaseUrl(),
        toStateScopePath(scope) + '/clients',
        'GET',
        undefined,
        options,
    );
}

export async function listStateGroups(
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupStateSnapshot[]> {
    return await executeHttpRequest<void, GroupStateSnapshot[]>(
        readApiBaseUrl(),
        toStateScopePath(scope) + '/groups',
        'GET',
        undefined,
        options,
    );
}

export async function findStateGroup(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupStateSnapshot> {
    return await executeHttpRequest<void, GroupStateSnapshot>(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}`,
        'GET',
        undefined,
        options,
    );
}

export async function listStateGroupEvents(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: GroupStateEventListRequestOptions,
): Promise<GroupEvent[]> {
    return await executeHttpRequest<void, GroupEvent[]>(
        readApiBaseUrl(),
        withStateEventListQuery(
            `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}/events`,
            options,
        ),
        'GET',
        undefined,
        options,
    );
}

export async function listStateGroupEventPage(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: GroupStateEventListRequestOptions,
): Promise<StateEventPage<GroupEvent>> {
    return await executeHttpRequest<void, StateEventPage<GroupEvent>>(
        readApiBaseUrl(),
        withStateEventListQuery(
            `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}/events/page`,
            options,
        ),
        'GET',
        undefined,
        options,
    );
}

export async function listStateClientEvents(
    principalId: string,
    scope: StateScope = defaultStateScope(),
    options?: ClientStateEventListRequestOptions,
): Promise<ClientEvent[]> {
    return await executeHttpRequest<void, ClientEvent[]>(
        readApiBaseUrl(),
        withStateEventListQuery(
            `${toStateScopePath(scope)}/clients/${encodeURIComponent(principalId)}/events`,
            options,
        ),
        'GET',
        undefined,
        options,
    );
}

export async function listStateClientEventPage(
    principalId: string,
    scope: StateScope = defaultStateScope(),
    options?: ClientStateEventListRequestOptions,
): Promise<StateEventPage<ClientEvent>> {
    return await executeHttpRequest<void, StateEventPage<ClientEvent>>(
        readApiBaseUrl(),
        withStateEventListQuery(
            `${toStateScopePath(scope)}/clients/${encodeURIComponent(principalId)}/events/page`,
            options,
        ),
        'GET',
        undefined,
        options,
    );
}

export async function readStateScopedGlobalGraph(
    scope: StateScope = defaultStateScope(),
    options?: StateGraphDiagnosticReadOptions,
): Promise<GraphDiagnosticReadResponse> {
    return await executeHttpRequest<void, GraphDiagnosticReadResponse>(
        readApiBaseUrl(),
        withGraphDiagnosticQuery(
            `${toStateScopePath(scope)}/graphs/global`,
            options,
        ),
        'GET',
        undefined,
        options,
    );
}

export async function readStateGroupGraph(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: StateGraphDiagnosticReadOptions,
): Promise<GraphDiagnosticReadResponse> {
    return await executeHttpRequest<void, GraphDiagnosticReadResponse>(
        readApiBaseUrl(),
        withGraphDiagnosticQuery(
            `${toStateGroupPath(scope, groupId)}/graphs/latest`,
            options,
        ),
        'GET',
        undefined,
        options,
    );
}

export async function readStateGroupTopology(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupTopologyManagementView> {
    return await executeHttpRequest<void, GroupTopologyManagementView>(
        readApiBaseUrl(),
        `${toStateGroupPath(scope, groupId)}/topology`,
        'GET',
        undefined,
        options,
    );
}

export async function readStateWorkspaceStatsSummary(
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<WorkspaceSpaStatisticsResponse> {
    return await executeHttpRequest<void, WorkspaceSpaStatisticsResponse>(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/stats/summary`,
        'GET',
        undefined,
        options,
    );
}

export async function readStateGroupStats(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupSpaStatisticsResponse> {
    return await executeHttpRequest<void, GroupSpaStatisticsResponse>(
        readApiBaseUrl(),
        `${toStateGroupPath(scope, groupId)}/stats`,
        'GET',
        undefined,
        options,
    );
}

export async function readStateMyRealtimeStatus(
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<MyRealtimeSpaStatisticsResponse> {
    return await executeHttpRequest<void, MyRealtimeSpaStatisticsResponse>(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/stats/me/realtime`,
        'GET',
        undefined,
        options,
    );
}

export async function readStateGroupTopologyConfig(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupTopologyConfigView> {
    return await executeHttpRequest<void, GroupTopologyConfigView>(
        readApiBaseUrl(),
        `${toStateGroupPath(scope, groupId)}/topology/config`,
        'GET',
        undefined,
        options,
    );
}

export async function putStateGroupTopologyConfig(
    groupId: string,
    request: PutGroupTopologyConfigRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<PutStateGroupTopologyConfigResponse> {
    return await executeHttpRequest<
        PutGroupTopologyConfigRequest,
        PutStateGroupTopologyConfigResponse
    >(
        readApiBaseUrl(),
        `${toStateGroupPath(scope, groupId)}/topology/config`,
        'PUT',
        request,
        options,
    );
}

export async function deleteStateGroupTopologyConfig(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: StateGroupTopologyDeleteOptions,
): Promise<DeleteStateGroupTopologyConfigResponse> {
    return await executeHttpRequest<void, DeleteStateGroupTopologyConfigResponse>(
        readApiBaseUrl(),
        withTopologyDeleteQuery(
            `${toStateGroupPath(scope, groupId)}/topology/config`,
            options,
        ),
        'DELETE',
        undefined,
        options,
    );
}

export async function readStateGroupTopologyOverride(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<StoredGroupTopologyOverride | Record<string, never>> {
    return await executeHttpRequest<void, StoredGroupTopologyOverride | Record<string, never>>(
        readApiBaseUrl(),
        `${toStateGroupPath(scope, groupId)}/topology/override`,
        'GET',
        undefined,
        options,
    );
}

export async function putStateGroupTopologyOverride(
    groupId: string,
    request: PutGroupTopologyOverrideRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<PutStateGroupTopologyOverrideResponse> {
    return await executeHttpRequest<
        PutGroupTopologyOverrideRequest,
        PutStateGroupTopologyOverrideResponse
    >(
        readApiBaseUrl(),
        `${toStateGroupPath(scope, groupId)}/topology/override`,
        'PUT',
        request,
        options,
    );
}

export async function deleteStateGroupTopologyOverride(
    groupId: string,
    scope: StateScope = defaultStateScope(),
    options?: StateGroupTopologyDeleteOptions,
): Promise<DeleteStateGroupTopologyConfigResponse> {
    return await executeHttpRequest<void, DeleteStateGroupTopologyConfigResponse>(
        readApiBaseUrl(),
        withTopologyDeleteQuery(
            `${toStateGroupPath(scope, groupId)}/topology/override`,
            options,
        ),
        'DELETE',
        undefined,
        options,
    );
}

export async function reconfigureStateGroupTopology(
    groupId: string,
    request: ReconfigureGroupTopologyRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<ReconfigureGroupTopologyResponse> {
    return await executeHttpRequest<
        ReconfigureGroupTopologyRequest,
        ReconfigureGroupTopologyResponse
    >(
        readApiBaseUrl(),
        `${toStateGroupPath(scope, groupId)}/topology/reconfigure`,
        'POST',
        request,
        options,
    );
}

export async function createStateGroup(
    request: CreateGroupRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupStateSnapshot> {
    return await executeHttpRequest<CreateGroupRequest, GroupStateSnapshot>(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/groups`,
        'POST',
        request,
        options,
    );
}

export async function updateStateGroup(
    groupId: string,
    request: UpdateGroupRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupStateSnapshot> {
    return await executeHttpRequest<UpdateGroupRequest, GroupStateSnapshot>(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}`,
        'PUT',
        request,
        options,
    );
}

export async function appointStateGroupDirector(
    groupId: string,
    request: AppointGroupDirectorRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupStateSnapshot> {
    return await executeHttpRequest<AppointGroupDirectorRequest, GroupStateSnapshot>(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/groups/${
            encodeURIComponent(groupId)
        }/director/appoint`,
        'POST',
        request,
        options,
    );
}

export async function joinStateGroup(
    groupId: string,
    request: JoinGroupRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupStateSnapshot> {
    return await executeHttpRequest<JoinGroupRequest, GroupStateSnapshot>(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}/join`,
        'POST',
        request,
        options,
    );
}

export async function createStateGroupInvite(
    groupId: string,
    principalId: string,
    request: CreateGroupInviteRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupStateSnapshot> {
    return await executeHttpRequest<CreateGroupInviteRequest, GroupStateSnapshot>(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}/invites/${
            encodeURIComponent(principalId)
        }`,
        'POST',
        request,
        options,
    );
}

export async function revokeStateGroupInvite(
    groupId: string,
    principalId: string,
    request: RevokeGroupInviteRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupStateSnapshot> {
    return await executeHttpRequest<RevokeGroupInviteRequest, GroupStateSnapshot>(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}/invites/${
            encodeURIComponent(principalId)
        }/revoke`,
        'POST',
        request,
        options,
    );
}

export async function acceptStateGroupInvite(
    groupId: string,
    request: AcceptGroupInviteRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupStateSnapshot> {
    return await executeHttpRequest<AcceptGroupInviteRequest, GroupStateSnapshot>(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}/invites/accept`,
        'POST',
        request,
        options,
    );
}

export async function rotateStateGroupJoinCode(
    groupId: string,
    request: RotateGroupJoinCodeRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupJoinCodeResponse> {
    return await executeHttpRequest<RotateGroupJoinCodeRequest, GroupJoinCodeResponse>(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/groups/${
            encodeURIComponent(groupId)
        }/join-code/rotate`,
        'POST',
        request,
        options,
    );
}

export async function removeStateGroupMember(
    groupId: string,
    principalId: string,
    request: RemoveGroupMemberRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupStateSnapshot> {
    return await executeHttpRequest<RemoveGroupMemberRequest, GroupStateSnapshot>(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}/members/${
            encodeURIComponent(principalId)
        }/remove`,
        'POST',
        request,
        options,
    );
}

export async function banStateGroupMember(
    groupId: string,
    principalId: string,
    request: BanGroupMemberRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupStateSnapshot> {
    return await executeHttpRequest<BanGroupMemberRequest, GroupStateSnapshot>(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}/members/${
            encodeURIComponent(principalId)
        }/ban`,
        'POST',
        request,
        options,
    );
}

export async function unbanStateGroupMember(
    groupId: string,
    principalId: string,
    request: UnbanGroupMemberRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupStateSnapshot> {
    return await executeHttpRequest<UnbanGroupMemberRequest, GroupStateSnapshot>(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}/members/${
            encodeURIComponent(principalId)
        }/unban`,
        'POST',
        request,
        options,
    );
}

export async function setStateGroupMemberRole(
    groupId: string,
    principalId: string,
    request: SetGroupMemberRoleRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupStateSnapshot> {
    return await executeHttpRequest<SetGroupMemberRoleRequest, GroupStateSnapshot>(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}/members/${
            encodeURIComponent(principalId)
        }/role`,
        'PUT',
        request,
        options,
    );
}

export async function transferStateGroupOwnership(
    groupId: string,
    request: TransferGroupOwnershipRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupStateSnapshot> {
    return await executeHttpRequest<TransferGroupOwnershipRequest, GroupStateSnapshot>(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/groups/${
            encodeURIComponent(groupId)
        }/owner/transfer`,
        'POST',
        request,
        options,
    );
}

export async function upsertStateGroupMember(
    groupId: string,
    principalId: string,
    request: UpsertGroupMemberRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupStateSnapshot> {
    return await executeHttpRequest<UpsertGroupMemberRequest, GroupStateSnapshot>(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}/members/${
            encodeURIComponent(principalId)
        }`,
        'PUT',
        request,
        options,
    );
}

export async function connectStateGroupPresenceSession(
    groupId: string,
    sessionId: string,
    request: ConnectGroupPresenceSessionRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupStateSnapshot> {
    return await executeHttpRequest<
        ConnectGroupPresenceSessionRequest,
        GroupStateSnapshot
    >(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}/sessions/${
            encodeURIComponent(sessionId)
        }`,
        'PUT',
        request,
        options,
    );
}

export async function connectStateClientSession(
    principalId: string,
    clientInstanceId: string,
    sessionId: string,
    request: ConnectClientSessionRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<ClientStateSnapshot> {
    return await executeHttpRequest<
        ConnectClientSessionRequest,
        ClientStateSnapshot
    >(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/clients/${encodeURIComponent(principalId)}/instances/${
            encodeURIComponent(clientInstanceId)
        }/sessions/${encodeURIComponent(sessionId)}`,
        'PUT',
        request,
        options,
    );
}

export async function heartbeatStateClientSession(
    principalId: string,
    clientInstanceId: string,
    sessionId: string,
    request: HeartbeatClientSessionRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<ClientStateSnapshot> {
    return await executeHttpRequest<
        HeartbeatClientSessionRequest,
        ClientStateSnapshot
    >(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/clients/${encodeURIComponent(principalId)}/instances/${
            encodeURIComponent(clientInstanceId)
        }/sessions/${encodeURIComponent(sessionId)}/heartbeat`,
        'POST',
        request,
        options,
    );
}

export async function heartbeatStateGroupPresenceSession(
    groupId: string,
    sessionId: string,
    request: HeartbeatGroupPresenceSessionRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupStateSnapshot> {
    return await executeHttpRequest<
        HeartbeatGroupPresenceSessionRequest,
        GroupStateSnapshot
    >(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}/sessions/${
            encodeURIComponent(sessionId)
        }/heartbeat`,
        'POST',
        request,
        options,
    );
}

export async function disconnectStateGroupPresenceSession(
    groupId: string,
    sessionId: string,
    request: DisconnectGroupPresenceSessionRequest,
    scope: StateScope = defaultStateScope(),
    options?: ApiRequestOptions,
): Promise<GroupStateSnapshot> {
    return await executeHttpRequest<
        DisconnectGroupPresenceSessionRequest,
        GroupStateSnapshot
    >(
        readApiBaseUrl(),
        `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}/sessions/${
            encodeURIComponent(sessionId)
        }/disconnect`,
        'POST',
        request,
        options,
    );
}

function toStateScopePath(scope: StateScope): string {
    return `/api/state/apps/${encodeURIComponent(scope.applicationId)}/workspaces/${
        encodeURIComponent(scope.workspaceId)
    }`;
}

function toStateGroupPath(scope: StateScope, groupId: string): string {
    return `${toStateScopePath(scope)}/groups/${encodeURIComponent(groupId)}`;
}

function withGraphDiagnosticQuery(
    path: string,
    options?: StateGraphDiagnosticReadOptions,
): string {
    const searchParams = new URLSearchParams();
    if (options?.includeMeasured !== undefined) {
        searchParams.set('includeMeasured', String(options.includeMeasured));
    }
    if (options?.refresh !== undefined) {
        searchParams.set('refresh', options.refresh);
    }

    return withSearchParams(path, searchParams);
}

function withTopologyDeleteQuery(
    path: string,
    options?: StateGroupTopologyDeleteOptions,
): string {
    const searchParams = new URLSearchParams();
    if (options?.reconfigure !== undefined) {
        searchParams.set('reconfigure', String(options.reconfigure));
    }

    return withSearchParams(path, searchParams);
}

function withStateEventListQuery<TEventType extends string>(
    path: string,
    options?: StateEventListRequestOptions<TEventType>,
): string {
    const searchParams = new URLSearchParams();
    for (const eventType of options?.eventTypes ?? []) {
        searchParams.append('eventType', eventType);
    }
    if (options?.limit !== undefined) {
        searchParams.set('limit', String(options.limit));
    }
    if (options?.after) {
        searchParams.set(
            'afterSnapshotVersion',
            String(options.after.snapshotVersion),
        );
        searchParams.set(
            'afterOccurredAtEpochMs',
            String(options.after.occurredAtEpochMs),
        );
        searchParams.set('afterEventId', options.after.eventId);
    }

    return withSearchParams(path, searchParams);
}

function withSearchParams(path: string, searchParams: URLSearchParams): string {
    const query = searchParams.toString();
    return query ? `${path}?${query}` : path;
}
