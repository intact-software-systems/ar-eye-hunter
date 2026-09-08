import { type IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { NonRetryableException } from '@shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { AppInboxType, type AppInboxEnqueueInput } from '../../app-inbox/app-inbox-contracts.ts';
import type {
    ClientMutationAuthority,
    ClientMutationCommand,
    ClientMutationCommandInput,
    ClientMutationIssuedSessionAuthority
} from '../mutation/client-mutation-contracts.ts';

export interface AuthenticatedClientMutationIngress {
    readonly scope: StateScope;
    readonly operation: Exclude<ClientMutationCommand['operation'], 'expireSession'>;
    readonly topicId: AppInboxType;
    readonly requestId: string;
    readonly contextId: string;
    readonly principalId: string;
    readonly sessionId: string | null;
    readonly actorPrincipalId: string | null;
    readonly actorSessionId: string | null;
    readonly senderId: string;
}

type ClientIngressPrimitive = string | number | boolean | null | undefined;
type ClientIngressValue =
    | ClientIngressPrimitive
    | ClientIngressRecord
    | readonly ClientIngressValue[];

interface ClientIngressRecord {
    readonly [key: string]: ClientIngressValue;
}

export interface IssuedClientMutationIngressValidationIssue {
    readonly path: string;
    readonly message: string;
    readonly cause: NonRetryableException;
}

export function readAuthenticatedClientMutationIngress(
    enqueue: AppInboxEnqueueInput
): AuthenticatedClientMutationIngress {
    const data = requireClientIngressRecord(enqueue.data, 'Client mutation payload');
    const scope = readClientIngressScope(data.scope);
    const principalId = requireClientIngressString(data.principalId, 'Client mutation principalId');
    const request = requireClientIngressRecord(data.request, 'Client mutation request');
    const requestId = requireClientIngressString(request.requestId, 'Client mutation requestId');
    const actorPrincipalId = readNullableClientIngressString(
        request.actorPrincipalId,
        'Client mutation actorPrincipalId'
    );
    const actorSessionId = readNullableClientIngressString(
        request.actorSessionId,
        'Client mutation actorSessionId'
    );
    const senderId = requireClientIngressString(enqueue.senderId, 'Client mutation senderId');
    const topicId = requireClientIngressString(enqueue.topicId, 'Client mutation topicId');
    const resourceId = requireClientIngressString(enqueue.resourceId, 'Client mutation resourceId');
    const contextId = requireClientIngressString(enqueue.contextId, 'Client mutation contextId');
    if (topicId !== enqueue.type || resourceId !== requestId) {
        throw new NonRetryableException(
            'Client mutation AppInbox operation or request identity differs.'
        );
    }
    const operation = readClientIngressOperation(enqueue.type, data);
    return {
        scope,
        operation,
        topicId: enqueue.type,
        requestId,
        contextId,
        principalId,
        sessionId: operation === 'upsertPrincipal' || operation === 'upsertInstance'
            ? null
            : requireClientIngressString(data.sessionId, 'Client mutation sessionId'),
        actorPrincipalId,
        actorSessionId,
        senderId
    };
}

function readClientIngressOperation(
    type: AppInboxType,
    data: ClientIngressRecord
): AuthenticatedClientMutationIngress['operation'] {
    switch (type) {
        case AppInboxType.CLIENT_PRINCIPAL_UPSERT:
            return 'upsertPrincipal';
        case AppInboxType.CLIENT_INSTANCE_UPSERT:
            requireClientIngressString(data.clientInstanceId, 'Client mutation clientInstanceId');
            return 'upsertInstance';
        case AppInboxType.CLIENT_SESSION_CONNECT:
        case AppInboxType.CLIENT_SESSION_HEARTBEAT:
        case AppInboxType.CLIENT_SESSION_DISCONNECT:
            requireClientIngressString(data.clientInstanceId, 'Client mutation clientInstanceId');
            return toSessionMutationOperation(type);
        default:
            throw new NonRetryableException('App inbox type is not an authenticated client mutation.');
    }
}

export function validateIssuedClientMutationIngress(
    authority: IssuedAuthSession,
    ingress: AuthenticatedClientMutationIngress,
    nowEpochMs: number
): readonly IssuedClientMutationIngressValidationIssue[] {
    const issues = validateIssuedClientSession(authority, nowEpochMs);
    if (ingress.principalId !== authority.clientId) {
        issues.push(toIngressValidationIssue(
            'ingress.principalId',
            'Authenticated client mutation principal differs from issued authority.'
        ));
    }
    if (ingress.senderId !== authority.clientId) {
        issues.push(toIngressValidationIssue(
            'ingress.senderId',
            'Authenticated client mutation sender differs from issued authority.'
        ));
    }
    if (ingress.actorPrincipalId !== null && ingress.actorPrincipalId !== authority.clientId) {
        issues.push(toIngressValidationIssue(
            'ingress.actorPrincipalId',
            'Authenticated client mutation actor principal differs from issued authority.'
        ));
    }
    if (ingress.actorSessionId !== null && ingress.actorSessionId !== authority.sessionId) {
        issues.push(toIngressValidationIssue(
            'ingress.actorSessionId',
            'Authenticated client mutation actor session differs from issued authority.'
        ));
    }
    if (ingress.sessionId !== null && ingress.sessionId !== authority.sessionId) {
        issues.push(toIngressValidationIssue(
            'ingress.sessionId',
            'Authenticated client mutation session differs from issued authority.'
        ));
    }
    const expectedContextId = toAuthenticatedClientMutationContextId({
        scope: ingress.scope,
        principalId: ingress.principalId,
        callerClientId: authority.clientId,
        callerSessionId: authority.sessionId
    });
    if (ingress.contextId !== expectedContextId) {
        issues.push(toIngressValidationIssue(
            'ingress.contextId',
            'Authenticated client mutation AppInbox context differs.'
        ));
    }
    return issues;
}

function validateIssuedClientSession(
    authority: IssuedAuthSession,
    nowEpochMs: number
): IssuedClientMutationIngressValidationIssue[] {
    const issues: IssuedClientMutationIngressValidationIssue[] = [];
    if (!authority.accessToken) {
        issues.push(toIngressValidationIssue(
            'authority.accessToken',
            'Authenticated client mutation access token is missing.'
        ));
    }
    if (!authority.sessionId) {
        issues.push(toIngressValidationIssue(
            'authority.sessionId',
            'Authenticated client mutation session id is missing.'
        ));
    }
    if (!authority.clientId) {
        issues.push(toIngressValidationIssue(
            'authority.clientId',
            'Authenticated client mutation client id is missing.'
        ));
    }
    if (authority.issuedAtEpochMs >= authority.expiresAtEpochMs) {
        issues.push(toIngressValidationIssue(
            'authority.expiresAtEpochMs',
            'Authenticated client mutation session expiry must follow issuance.'
        ));
    }
    if (authority.expiresAtEpochMs <= nowEpochMs) {
        issues.push(toIngressValidationIssue(
            'authority.expiresAtEpochMs',
            'Authenticated client mutation session is expired.'
        ));
    }
    return issues;
}

function toIngressValidationIssue(
    path: string,
    message: string
): IssuedClientMutationIngressValidationIssue {
    return { path, message, cause: new NonRetryableException(message) };
}

export function toAuthenticatedClientMutationContextId(
    input: Readonly<{
        scope: StateScope;
        principalId: string;
        callerClientId: string;
        callerSessionId: string;
    }>
): string {
    return [
        ['application', input.scope.applicationId],
        ['workspace', input.scope.workspaceId],
        ['principal', input.principalId],
        ['caller', input.callerClientId],
        ['session', input.callerSessionId]
    ].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join(':');
}

export function readClientMutationAuthority<Authority>(
    authority: Authority,
    operation: ClientMutationCommandInput['operation']
): ClientMutationAuthority {
    const value = requireClientIngressRecord(authority, 'Client mutation authority');
    if (value.kind === 'issued-session') {
        const proof = readIssuedClientAuthority(value);
        if (proof.operation !== operation) {
            throw new NonRetryableException(
                'Client mutation authority operation differs from command.'
            );
        }
        return proof;
    }
    if (value.kind === 'system') {
        const proof: ClientMutationAuthority = {
            kind: 'system',
            version: requireClientAuthorityVersion(value.version),
            serviceId: requireClientIngressString(
                value.serviceId,
                'Client mutation authority serviceId'
            ),
            operation: value.operation === 'expireSession'
                ? value.operation
                : invalidClientAuthorityOperation()
        };
        if (operation !== 'expireSession') {
            throw new NonRetryableException(
                'System authority is only valid for client session expiry.'
            );
        }
        return proof;
    }
    throw new NonRetryableException('Client mutation authority kind is invalid.');
}

function readIssuedClientAuthority(
    value: ClientIngressRecord
): ClientMutationIssuedSessionAuthority {
    return {
        kind: 'issued-session',
        version: requireClientAuthorityVersion(value.version),
        principalId: requireClientIngressString(
            value.principalId,
            'Client mutation authority principalId'
        ),
        sessionId: requireClientIngressString(
            value.sessionId,
            'Client mutation authority sessionId'
        ),
        sessionIssuedAtEpochMs: requireClientIngressTimestamp(
            value.sessionIssuedAtEpochMs,
            'Client mutation authority issuedAtEpochMs'
        ),
        sessionExpiresAtEpochMs: requireClientIngressTimestamp(
            value.sessionExpiresAtEpochMs,
            'Client mutation authority expiresAtEpochMs'
        ),
        applicationId: requireClientIngressString(
            value.applicationId,
            'Client mutation authority applicationId'
        ),
        workspaceId: requireClientIngressString(
            value.workspaceId,
            'Client mutation authority workspaceId'
        ),
        operation: readIssuedClientAuthorityOperation(value.operation)
    };
}

function toSessionMutationOperation(
    type: AppInboxType
): Extract<ClientMutationCommand['operation'], 'connectSession' | 'heartbeatSession' | 'disconnectSession'> {
    switch (type) {
        case AppInboxType.CLIENT_SESSION_CONNECT:
            return 'connectSession';
        case AppInboxType.CLIENT_SESSION_HEARTBEAT:
            return 'heartbeatSession';
        case AppInboxType.CLIENT_SESSION_DISCONNECT:
            return 'disconnectSession';
        default:
            throw new NonRetryableException('App inbox type is not a client session mutation.');
    }
}

function readIssuedClientAuthorityOperation(
    operation: ClientIngressValue
): Exclude<ClientMutationCommand['operation'], 'expireSession'> {
    switch (operation) {
        case 'upsertPrincipal':
        case 'upsertInstance':
        case 'connectSession':
        case 'connectAuthorisedWsSession':
        case 'heartbeatSession':
        case 'disconnectSession':
        case 'disconnectAuthorisedWsSession':
            return operation;
        default:
            return invalidClientAuthorityOperation();
    }
}

function invalidClientAuthorityOperation(): never {
    throw new NonRetryableException('Client mutation authority operation is invalid.');
}

function requireClientIngressRecord<Value>(value: Value, label: string): ClientIngressRecord {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new NonRetryableException(`${label} must be an object.`);
    }
    return Object.fromEntries(Object.entries(value as object)) as ClientIngressRecord;
}

function readClientIngressScope(value: ClientIngressValue): StateScope {
    const scope = requireClientIngressRecord(value, 'Client mutation scope');
    return {
        applicationId: requireClientIngressString(
            scope.applicationId,
            'Client mutation applicationId'
        ),
        workspaceId: requireClientIngressString(scope.workspaceId, 'Client mutation workspaceId')
    };
}

function readNullableClientIngressString(value: ClientIngressValue, label: string): string | null {
    return value === undefined || value === null ? null : requireClientIngressString(value, label);
}

function requireClientIngressString(value: ClientIngressValue, label: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new NonRetryableException(`${label} is required.`);
    }
    return value;
}

function requireClientIngressTimestamp(value: ClientIngressValue, label: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new NonRetryableException(`${label} is invalid.`);
    }
    return value;
}

function requireClientAuthorityVersion(value: ClientIngressValue): 1 {
    if (value !== 1) {
        throw new NonRetryableException('Client mutation authority version is invalid.');
    }
    return value;
}
