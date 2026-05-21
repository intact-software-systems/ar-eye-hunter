import { readApiBaseUrl } from './api-client-config.ts';
import { readSession } from '@shared/api/auth.ts';
import {
    ApiConfig,
    type AuthSession,
    IceConfig,
    LoginRequest,
    LoginResponse,
    LogoutResponse,
    RegisterRequest,
    RegisterResponse,
    WebSocketTicketResponse,
} from '@shared/api/api-config.ts';
import type { ClientSnapshot as ClientStateSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot as GroupStateSnapshot } from '@shared/api/group-types.ts';
import {
    type ConnectGroupPresenceSessionRequest,
    type CreateGroupRequest,
    DEFAULT_STATE_APPLICATION_ID,
    DEFAULT_STATE_WORKSPACE_ID,
    type DisconnectGroupPresenceSessionRequest,
    type HeartbeatClientSessionRequest,
    type HeartbeatGroupPresenceSessionRequest,
    type StateScope,
    type UpsertGroupMemberRequest,
} from '@shared/api/state-types.ts';

export type ApiRequestOptions = Readonly<{
    signal?: AbortSignal;
    authSession?: AuthSession | null;
}>;

export class ApiHttpError extends Error {
    public constructor(
        public readonly method: 'GET' | 'POST' | 'PUT',
        public readonly path: string,
        public readonly status: number,
        public readonly bodyText: string,
    ) {
        super(`API ${method} ${path} failed: ${status} ${bodyText}`);
        this.name = 'ApiHttpError';
    }
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

async function executeHttpRequest<TReq, TRes>(
    baseUrl: string,
    path: string,
    method: 'GET' | 'POST' | 'PUT',
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
        if (!body) {
            throw new Error(`${method} ${path} requires a body`);
        }
        init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);

    if (!res.ok) {
        const txt = await readTextOrElse(res, () => '');

        throw new ApiHttpError(method, path, res.status, txt);
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

export async function createWebSocketTicket(
    options?: ApiRequestOptions,
): Promise<WebSocketTicketResponse> {
    return await executeHttpRequest<Record<string, never>, WebSocketTicketResponse>(
        readApiBaseUrl(),
        '/api/auth/ws-ticket',
        'POST',
        {},
        options,
    );
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

export function defaultStateScope(): StateScope {
    return {
        applicationId: DEFAULT_STATE_APPLICATION_ID,
        workspaceId: DEFAULT_STATE_WORKSPACE_ID,
    };
}

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
