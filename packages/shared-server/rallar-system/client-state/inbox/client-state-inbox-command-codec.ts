import type {
    ConnectClientSessionRequest,
    DisconnectClientSessionRequest,
    HeartbeatClientSessionRequest,
    MutationActorInput,
    StateScope,
    UpsertClientInstanceRequest,
    UpsertClientPrincipalRequest
} from '@shared/api/state-types.ts';
import {
    requireEpoch,
    requireExactKeys,
    requireExactOptionalKeys,
    requireOneOf,
    requireString
} from '../../protocol/exact-object-decoding.ts';
import type { JsonWireObject, JsonWireValue } from '../../protocol/json-wire-identity.ts';
import type { ClientExpiredSessionPageInput } from '../client-state-service-contracts.ts';
import type {
    ClientAuthorisedWsSessionConnectAppInboxPayload,
    ClientAuthorisedWsSessionDisconnectAppInboxPayload,
    ClientInstanceUpsertAppInboxPayload,
    ClientPrincipalUpsertAppInboxPayload,
    ClientSessionConnectAppInboxPayload,
    ClientSessionDisconnectAppInboxPayload,
    ClientSessionHeartbeatAppInboxPayload
} from './app-client-inbox-contracts.ts';

const MUTATION_ACTOR_FIELDS = [
    'actorPrincipalId',
    'actorSessionId',
    'reason',
    'traceId',
    'requestId'
] as const;
const CLIENT_PRINCIPAL_STATUSES = ['active', 'disabled', 'deleted'] as const;
const CLIENT_INSTANCE_STATUSES = ['active', 'revoked', 'retired'] as const;
const CLIENT_PRESENCE_STATES = ['online', 'offline', 'away', 'busy'] as const;
const CLIENT_PLATFORMS = ['web', 'ios', 'android', 'desktop', 'server', 'unknown'] as const;
const CLIENT_TRANSPORTS = ['ws', 'http', 'rtc', 'unknown'] as const;

export function decodeClientPrincipalUpsertAppInboxPayload(
    value: JsonWireValue
): ClientPrincipalUpsertAppInboxPayload {
    const payload = requireJsonWireObject(value, 'Client principal AppInbox payload');
    requireExactKeys(payload, ['scope', 'principalId', 'request'], 'Client principal AppInbox payload');
    return {
        scope: decodeStateScope(payload.scope),
        principalId: readString(payload.principalId, 'Client principal id'),
        request: decodeUpsertClientPrincipalRequest(payload.request)
    };
}

export function decodeClientInstanceUpsertAppInboxPayload(
    value: JsonWireValue
): ClientInstanceUpsertAppInboxPayload {
    const payload = requireJsonWireObject(value, 'Client instance AppInbox payload');
    requireExactKeys(
        payload,
        ['scope', 'principalId', 'clientInstanceId', 'request'],
        'Client instance AppInbox payload'
    );
    return {
        scope: decodeStateScope(payload.scope),
        principalId: readString(payload.principalId, 'Client instance principal id'),
        clientInstanceId: readString(payload.clientInstanceId, 'Client instance id'),
        request: decodeUpsertClientInstanceRequest(payload.request)
    };
}

export function decodeClientSessionConnectAppInboxPayload(
    value: JsonWireValue
): ClientSessionConnectAppInboxPayload {
    const payload = decodeClientSessionPayload(value, 'Client session connect AppInbox payload');
    return { ...payload, request: decodeConnectClientSessionRequest(payload.request) };
}

export function decodeClientSessionHeartbeatAppInboxPayload(
    value: JsonWireValue
): ClientSessionHeartbeatAppInboxPayload {
    const payload = decodeClientSessionPayload(value, 'Client session heartbeat AppInbox payload');
    return { ...payload, request: decodeHeartbeatClientSessionRequest(payload.request) };
}

export function decodeClientSessionDisconnectAppInboxPayload(
    value: JsonWireValue
): ClientSessionDisconnectAppInboxPayload {
    const payload = decodeClientSessionPayload(value, 'Client session disconnect AppInbox payload');
    return { ...payload, request: decodeDisconnectClientSessionRequest(payload.request) };
}

export function decodeClientAuthorisedWsSessionConnectAppInboxPayload(
    value: JsonWireValue
): ClientAuthorisedWsSessionConnectAppInboxPayload {
    const payload = requireJsonWireObject(value, 'Authorised WebSocket connect AppInbox payload');
    requireExactKeys(
        payload,
        [
            'authSession',
            'generationId',
            'generationStartedAtEpochMs',
            'scope',
            'principalId',
            'clientInstanceId',
            'displayName',
            'userAgent',
            'platform',
            'capabilities',
            'expiresAtEpochMs'
        ],
        'Authorised WebSocket connect AppInbox payload'
    );
    const authSession = requireJsonWireObject(
        payload.authSession,
        'Authorised WebSocket auth session'
    );
    requireExactKeys(
        authSession,
        ['clientId', 'username', 'sessionId', 'issuedAtEpochMs', 'expiresAtEpochMs'],
        'Authorised WebSocket auth session'
    );
    return {
        authSession: {
            clientId: readString(authSession.clientId, 'Authorised WebSocket client id'),
            username: readString(authSession.username, 'Authorised WebSocket username'),
            sessionId: readString(authSession.sessionId, 'Authorised WebSocket session id'),
            issuedAtEpochMs: readEpoch(authSession.issuedAtEpochMs, 'Authorised WebSocket issued time'),
            expiresAtEpochMs: readEpoch(authSession.expiresAtEpochMs, 'Authorised WebSocket expiry time')
        },
        generationId: readString(payload.generationId, 'Authorised WebSocket generation id'),
        generationStartedAtEpochMs: readEpoch(
            payload.generationStartedAtEpochMs,
            'Authorised WebSocket generation start'
        ),
        scope: decodeStateScope(payload.scope),
        principalId: readString(payload.principalId, 'Authorised WebSocket principal id'),
        clientInstanceId: readString(payload.clientInstanceId, 'Authorised WebSocket client instance id'),
        displayName: readString(payload.displayName, 'Authorised WebSocket display name'),
        userAgent: readNullableString(payload.userAgent, 'Authorised WebSocket user agent'),
        platform: requireOneOf(payload.platform, CLIENT_PLATFORMS, 'Authorised WebSocket platform'),
        capabilities: readStringArray(payload.capabilities, 'Authorised WebSocket capabilities'),
        expiresAtEpochMs: readEpoch(payload.expiresAtEpochMs, 'Authorised WebSocket expiry time')
    };
}

export function decodeClientAuthorisedWsSessionDisconnectAppInboxPayload(
    value: JsonWireValue
): ClientAuthorisedWsSessionDisconnectAppInboxPayload {
    const payload = requireJsonWireObject(
        value,
        'Authorised WebSocket disconnect AppInbox payload'
    );
    requireExactKeys(
        payload,
        ['connection', 'disconnectedAtEpochMs', 'reason'],
        'Authorised WebSocket disconnect AppInbox payload'
    );
    return {
        connection: decodeClientAuthorisedWsSessionConnectAppInboxPayload(
            requireJsonWireValue(payload.connection, 'Authorised WebSocket connection')
        ),
        disconnectedAtEpochMs: readEpoch(
            payload.disconnectedAtEpochMs,
            'Authorised WebSocket disconnect time'
        ),
        reason: readString(payload.reason, 'Authorised WebSocket disconnect reason')
    };
}

export function decodeClientExpiredSessionsAppInboxPayload(
    value: JsonWireValue
): ClientExpiredSessionPageInput {
    const payload = requireJsonWireObject(value, 'Client expiry AppInbox payload');
    requireExactKeys(payload, ['atEpochMs', 'afterKey'], 'Client expiry AppInbox payload');
    return {
        atEpochMs: readEpoch(payload.atEpochMs, 'Client expiry time'),
        afterKey: readNullableString(payload.afterKey, 'Client expiry cursor')
    };
}

function decodeClientSessionPayload(value: JsonWireValue, label: string): Readonly<{
    scope: StateScope;
    principalId: string;
    clientInstanceId: string;
    sessionId: string;
    request: JsonWireValue;
}> {
    const payload = requireJsonWireObject(value, label);
    requireExactKeys(
        payload,
        ['scope', 'principalId', 'clientInstanceId', 'sessionId', 'request'],
        label
    );
    return {
        scope: decodeStateScope(payload.scope),
        principalId: readString(payload.principalId, `${label} principal id`),
        clientInstanceId: readString(payload.clientInstanceId, `${label} client instance id`),
        sessionId: readString(payload.sessionId, `${label} session id`),
        request: payload.request
    };
}

function decodeStateScope(value: JsonWireValue | undefined): StateScope {
    const scope = requireJsonWireObject(value, 'Client AppInbox scope');
    requireExactKeys(scope, ['applicationId', 'workspaceId'], 'Client AppInbox scope');
    return {
        applicationId: readString(scope.applicationId, 'Client scope application id'),
        workspaceId: readString(scope.workspaceId, 'Client scope workspace id')
    };
}

function decodeUpsertClientPrincipalRequest(
    value: JsonWireValue | undefined
): UpsertClientPrincipalRequest {
    const request = requireJsonWireObject(value, 'Client principal request');
    requireExactOptionalKeys({
        value: request,
        required: ['username'],
        optional: [
            ...MUTATION_ACTOR_FIELDS,
            'displayName',
            'avatarUrl',
            'status',
            'authProvider',
            'externalSubjectId',
            'roles',
            'metadata',
            'lastSeenAtEpochMs'
        ],
        label: 'Client principal request'
    });
    return {
        ...decodeMutationActor(request),
        username: readString(request.username, 'Client principal username'),
        ...optionalStringField(request, 'displayName'),
        ...optionalStringField(request, 'avatarUrl'),
        ...(request.status === undefined
            ? {}
            : { status: requireOneOf(request.status, CLIENT_PRINCIPAL_STATUSES, 'Client principal status') }),
        ...optionalStringField(request, 'authProvider'),
        ...optionalStringField(request, 'externalSubjectId'),
        ...(request.roles === undefined ? {} : { roles: readStringArray(request.roles, 'Client principal roles') }),
        ...(request.metadata === undefined
            ? {}
            : { metadata: requireJsonWireObject(request.metadata, 'Client principal metadata') }),
        ...optionalEpochField(request, 'lastSeenAtEpochMs')
    };
}

function decodeUpsertClientInstanceRequest(
    value: JsonWireValue | undefined
): UpsertClientInstanceRequest {
    const request = requireJsonWireObject(value, 'Client instance request');
    requireExactOptionalKeys({
        value: request,
        required: [],
        optional: [
            ...MUTATION_ACTOR_FIELDS,
            'status',
            'platform',
            'deviceLabel',
            'appVersion',
            'userAgent',
            'capabilities'
        ],
        label: 'Client instance request'
    });
    return {
        ...decodeMutationActor(request),
        ...(request.status === undefined
            ? {}
            : { status: requireOneOf(request.status, CLIENT_INSTANCE_STATUSES, 'Client instance status') }),
        ...(request.platform === undefined
            ? {}
            : { platform: requireOneOf(request.platform, CLIENT_PLATFORMS, 'Client instance platform') }),
        ...optionalStringField(request, 'deviceLabel'),
        ...optionalStringField(request, 'appVersion'),
        ...optionalStringField(request, 'userAgent'),
        ...(request.capabilities === undefined
            ? {}
            : { capabilities: readStringArray(request.capabilities, 'Client instance capabilities') })
    };
}

function decodeConnectClientSessionRequest(
    value: JsonWireValue | undefined
): ConnectClientSessionRequest {
    const request = decodeSessionRequest(value, 'Client session connect request', [
        'presenceState',
        'transport',
        'connectionId',
        'authenticatedAtEpochMs',
        'connectedAtEpochMs',
        'lastHeartbeatAtEpochMs',
        'expiresAtEpochMs'
    ]);
    return {
        ...decodeMutationActor(request),
        generationId: readString(request.generationId, 'Client session generation id'),
        ...(request.presenceState === undefined
            ? {}
            : { presenceState: requireOneOf(request.presenceState, CLIENT_PRESENCE_STATES, 'Client presence state') }),
        ...(request.transport === undefined
            ? {}
            : { transport: requireOneOf(request.transport, CLIENT_TRANSPORTS, 'Client session transport') }),
        ...optionalStringField(request, 'connectionId'),
        ...optionalEpochField(request, 'authenticatedAtEpochMs'),
        ...optionalEpochField(request, 'connectedAtEpochMs'),
        ...optionalEpochField(request, 'lastHeartbeatAtEpochMs'),
        ...optionalEpochField(request, 'expiresAtEpochMs')
    };
}

function decodeHeartbeatClientSessionRequest(
    value: JsonWireValue | undefined
): HeartbeatClientSessionRequest {
    const request = decodeSessionRequest(value, 'Client session heartbeat request', [
        'presenceState',
        'lastHeartbeatAtEpochMs',
        'expiresAtEpochMs'
    ]);
    return {
        ...decodeMutationActor(request),
        generationId: readString(request.generationId, 'Client session generation id'),
        ...(request.presenceState === undefined
            ? {}
            : { presenceState: requireOneOf(request.presenceState, CLIENT_PRESENCE_STATES, 'Client presence state') }),
        ...optionalEpochField(request, 'lastHeartbeatAtEpochMs'),
        ...optionalEpochField(request, 'expiresAtEpochMs')
    };
}

function decodeDisconnectClientSessionRequest(
    value: JsonWireValue | undefined
): DisconnectClientSessionRequest {
    const request = decodeSessionRequest(value, 'Client session disconnect request', [
        'disconnectedAtEpochMs',
        'lastHeartbeatAtEpochMs',
        'expiresAtEpochMs'
    ]);
    return {
        ...decodeMutationActor(request),
        generationId: readString(request.generationId, 'Client session generation id'),
        ...optionalEpochField(request, 'disconnectedAtEpochMs'),
        ...optionalEpochField(request, 'lastHeartbeatAtEpochMs'),
        ...optionalEpochField(request, 'expiresAtEpochMs')
    };
}

function decodeSessionRequest(
    value: JsonWireValue | undefined,
    label: string,
    optional: readonly string[]
): JsonWireObject {
    const request = requireJsonWireObject(value, label);
    requireExactOptionalKeys({
        value: request,
        required: ['generationId'],
        optional: [...MUTATION_ACTOR_FIELDS, ...optional],
        label
    });
    return request;
}

function decodeMutationActor(value: JsonWireObject): MutationActorInput {
    return {
        ...optionalStringField(value, 'actorPrincipalId'),
        ...optionalStringField(value, 'actorSessionId'),
        ...optionalStringField(value, 'reason'),
        ...optionalStringField(value, 'traceId'),
        ...optionalStringField(value, 'requestId')
    };
}

function optionalStringField(
    value: JsonWireObject,
    key: string
): Readonly<Record<string, string>> {
    return value[key] === undefined ? {} : { [key]: readString(value[key], key) };
}

function optionalEpochField(
    value: JsonWireObject,
    key: string
): Readonly<Record<string, number>> {
    return value[key] === undefined ? {} : { [key]: readEpoch(value[key], key) };
}

function readString(value: JsonWireValue | undefined, label: string): string {
    requireString(value, label);
    return value;
}

function readNullableString(value: JsonWireValue | undefined, label: string): string | null {
    return value === null ? null : readString(value, label);
}

function readEpoch(value: JsonWireValue | undefined, label: string): number {
    requireEpoch(value, label);
    return Number(value);
}

function readStringArray(value: JsonWireValue | undefined, label: string): readonly string[] {
    if (!Array.isArray(value)) {
        throw new TypeError(`${label} must be an array`);
    }
    return value.map((entry, index) => readString(entry, `${label} ${index}`));
}

function requireJsonWireValue(value: JsonWireValue | undefined, label: string): JsonWireValue {
    if (value === undefined) {
        throw new TypeError(`${label} is required`);
    }
    return value;
}

function requireJsonWireObject(
    value: JsonWireValue | undefined,
    label: string
): JsonWireObject {
    if (
        value === null || value === undefined || typeof value !== 'object' ||
        Array.isArray(value)
    ) {
        throw new TypeError(`${label} must be an exact object`);
    }
    return value as JsonWireObject;
}
