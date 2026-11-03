import {
    requireEpoch,
    requireExactKeys,
    requireExactOptionalKeys,
    requireOneOf,
    requireString
} from '@shared/api/exact-object-decoding.ts';
import type {
    ConnectClientSessionRequest,
    DisconnectClientSessionRequest,
    HeartbeatClientSessionRequest,
    MutationActorInput,
    StateScope,
    UpsertClientInstanceRequest,
    UpsertClientPrincipalRequest
} from '@shared/api/state-types.ts';
import type { JsonWireObject, JsonWireValue } from '../../protocol/json-wire-identity.ts';
import type { ClientExpiredSessionPageInput } from '../client-state-service-contracts.ts';
import type {
    ClientAuthorisedWsSessionConnectAppInboxPayload,
    ClientAuthorisedWsSessionDisconnectAppInboxPayload,
    ClientAuthorisedWsTicketConnectAppInboxPayload,
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
        principalId: decodeString(payload.principalId, 'Client principal id'),
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
        principalId: decodeString(payload.principalId, 'Client instance principal id'),
        clientInstanceId: decodeString(payload.clientInstanceId, 'Client instance id'),
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
            clientId: decodeString(authSession.clientId, 'Authorised WebSocket client id'),
            username: decodeString(authSession.username, 'Authorised WebSocket username'),
            sessionId: decodeString(authSession.sessionId, 'Authorised WebSocket session id'),
            issuedAtEpochMs: decodeEpoch(authSession.issuedAtEpochMs, 'Authorised WebSocket issued time'),
            expiresAtEpochMs: decodeEpoch(authSession.expiresAtEpochMs, 'Authorised WebSocket expiry time')
        },
        generationId: decodeString(payload.generationId, 'Authorised WebSocket generation id'),
        generationStartedAtEpochMs: decodeEpoch(
            payload.generationStartedAtEpochMs,
            'Authorised WebSocket generation start'
        ),
        scope: decodeStateScope(payload.scope),
        principalId: decodeString(payload.principalId, 'Authorised WebSocket principal id'),
        clientInstanceId: decodeString(payload.clientInstanceId, 'Authorised WebSocket client instance id'),
        displayName: decodeString(payload.displayName, 'Authorised WebSocket display name'),
        userAgent: decodeNullableString(payload.userAgent, 'Authorised WebSocket user agent'),
        platform: requireOneOf(payload.platform, CLIENT_PLATFORMS, 'Authorised WebSocket platform'),
        capabilities: decodeStringArray(payload.capabilities, 'Authorised WebSocket capabilities'),
        expiresAtEpochMs: decodeEpoch(payload.expiresAtEpochMs, 'Authorised WebSocket expiry time')
    };
}

export function decodeClientAuthorisedWsTicketConnectAppInboxPayload(
    value: JsonWireValue
): ClientAuthorisedWsTicketConnectAppInboxPayload {
    const payload = requireJsonWireObject(value, 'Authorised WebSocket ticket connect AppInbox payload');
    requireExactKeys(payload, ['connection', 'ticketDigest'], 'Authorised WebSocket ticket connect AppInbox payload');
    return {
        connection: decodeClientAuthorisedWsSessionConnectAppInboxPayload(
            requireJsonWireValue(payload.connection, 'Authorised WebSocket connection')
        ),
        ticketDigest: decodeString(payload.ticketDigest, 'Authorised WebSocket ticket digest')
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
        disconnectedAtEpochMs: decodeEpoch(
            payload.disconnectedAtEpochMs,
            'Authorised WebSocket disconnect time'
        ),
        reason: decodeString(payload.reason, 'Authorised WebSocket disconnect reason')
    };
}

export function decodeClientExpiredSessionsAppInboxPayload(
    value: JsonWireValue
): ClientExpiredSessionPageInput {
    const payload = requireJsonWireObject(value, 'Client expiry AppInbox payload');
    requireExactKeys(payload, ['atEpochMs', 'afterKey'], 'Client expiry AppInbox payload');
    return {
        atEpochMs: decodeEpoch(payload.atEpochMs, 'Client expiry time'),
        afterKey: decodeNullableString(payload.afterKey, 'Client expiry cursor')
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
        principalId: decodeString(payload.principalId, `${label} principal id`),
        clientInstanceId: decodeString(payload.clientInstanceId, `${label} client instance id`),
        sessionId: decodeString(payload.sessionId, `${label} session id`),
        request: payload.request
    };
}

function decodeStateScope(value: JsonWireValue | undefined): StateScope {
    const scope = requireJsonWireObject(value, 'Client AppInbox scope');
    requireExactKeys(scope, ['applicationId', 'workspaceId'], 'Client AppInbox scope');
    return {
        applicationId: decodeString(scope.applicationId, 'Client scope application id'),
        workspaceId: decodeString(scope.workspaceId, 'Client scope workspace id')
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
        username: decodeString(request.username, 'Client principal username'),
        ...optionalStringField(request, 'displayName'),
        ...optionalStringField(request, 'avatarUrl'),
        ...(request.status === undefined
            ? {}
            : { status: requireOneOf(request.status, CLIENT_PRINCIPAL_STATUSES, 'Client principal status') }),
        ...optionalStringField(request, 'authProvider'),
        ...optionalStringField(request, 'externalSubjectId'),
        ...(request.roles === undefined ? {} : { roles: decodeStringArray(request.roles, 'Client principal roles') }),
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
            : { capabilities: decodeStringArray(request.capabilities, 'Client instance capabilities') })
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
        generationId: decodeString(request.generationId, 'Client session generation id'),
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
        generationId: decodeString(request.generationId, 'Client session generation id'),
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
        generationId: decodeString(request.generationId, 'Client session generation id'),
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
        ...optionalStringField(value, 'requestId')
    };
}

function optionalStringField(
    value: JsonWireObject,
    key: string
): Readonly<Record<string, string>> {
    return value[key] === undefined ? {} : { [key]: decodeString(value[key], key) };
}

function optionalEpochField(
    value: JsonWireObject,
    key: string
): Readonly<Record<string, number>> {
    return value[key] === undefined ? {} : { [key]: decodeEpoch(value[key], key) };
}

function decodeString(value: JsonWireValue | undefined, label: string): string {
    requireString(value, label);
    return value;
}

function decodeNullableString(value: JsonWireValue | undefined, label: string): string | null {
    return value === null ? null : decodeString(value, label);
}

function decodeEpoch(value: JsonWireValue | undefined, label: string): number {
    requireEpoch(value, label);
    return Number(value);
}

function decodeStringArray(value: JsonWireValue | undefined, label: string): readonly string[] {
    if (!Array.isArray(value)) {
        throw new TypeError(`${label} must be an array`);
    }
    return value.map((entry, index) => decodeString(entry, `${label} ${index}`));
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
