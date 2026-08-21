import type { StateScope } from '@shared/api/state-types.ts';
import { NonRetryableException } from '@shared/queuebox/DequeueResourceEntryController.ts';
import type { IssuedAuthSession } from '../../repositories/AuthSessionRepository.ts';
import { AppInboxType, type AppInboxEnqueueInput } from '../../services/AppInboxService.ts';
import type {
    ClientMutationAuthority,
    ClientMutationCommand,
    ClientMutationCommandInput
} from '../mutation/client-mutation-contracts.ts';

export type AuthenticatedClientMutationIngress = Readonly<{
    scope: StateScope;
    operation: Exclude<ClientMutationCommand['operation'], 'expireSession'>;
    topicId: AppInboxType;
    requestId: string;
    contextId: string;
    principalId: string;
    sessionId: string | null;
    actorPrincipalId: string | null;
    actorSessionId: string | null;
    senderId: string;
}>;

type ClientIngressPrimitive = string | number | boolean | null | undefined;
type ClientIngressValue =
    | ClientIngressPrimitive
    | ClientIngressRecord
    | readonly ClientIngressValue[];

interface ClientIngressRecord {
    readonly [key: string]: ClientIngressValue;
}

export function readAuthenticatedClientMutationIngress<Payload>(
    enqueue: AppInboxEnqueueInput<Payload>
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
    switch (enqueue.type) {
        case AppInboxType.CLIENT_PRINCIPAL_UPSERT:
            return {
                scope,
                operation: 'upsertPrincipal',
                topicId: enqueue.type,
                requestId,
                contextId,
                principalId,
                sessionId: null,
                actorPrincipalId,
                actorSessionId,
                senderId
            };
        case AppInboxType.CLIENT_INSTANCE_UPSERT:
            requireClientIngressString(data.clientInstanceId, 'Client mutation clientInstanceId');
            return {
                scope,
                operation: 'upsertInstance',
                topicId: enqueue.type,
                requestId,
                contextId,
                principalId,
                sessionId: null,
                actorPrincipalId,
                actorSessionId,
                senderId
            };
        case AppInboxType.CLIENT_SESSION_CONNECT:
        case AppInboxType.CLIENT_SESSION_HEARTBEAT:
        case AppInboxType.CLIENT_SESSION_DISCONNECT:
            requireClientIngressString(data.clientInstanceId, 'Client mutation clientInstanceId');
            return {
                scope,
                operation: toSessionMutationOperation(enqueue.type),
                topicId: enqueue.type,
                requestId,
                contextId,
                principalId,
                sessionId: requireClientIngressString(data.sessionId, 'Client mutation sessionId'),
                actorPrincipalId,
                actorSessionId,
                senderId
            };
        default:
            throw new NonRetryableException(
                'App inbox type is not an authenticated client mutation.'
            );
    }
}

export function validateIssuedClientMutationIngress(
    authority: IssuedAuthSession,
    ingress: AuthenticatedClientMutationIngress
): void {
    if (
        !authority.accessToken ||
        !authority.sessionId ||
        !authority.clientId ||
        authority.issuedAtEpochMs >= authority.expiresAtEpochMs ||
        authority.expiresAtEpochMs <= Date.now()
    ) {
        throw new NonRetryableException(
            'Authenticated client mutation session is invalid or expired.'
        );
    }
    if (
        ingress.principalId !== authority.clientId ||
        ingress.senderId !== authority.clientId ||
        (ingress.actorPrincipalId !== null && ingress.actorPrincipalId !== authority.clientId) ||
        (ingress.actorSessionId !== null && ingress.actorSessionId !== authority.sessionId) ||
        (ingress.sessionId !== null && ingress.sessionId !== authority.sessionId)
    ) {
        throw new NonRetryableException(
            'Authenticated client mutation principal or session authority differs.'
        );
    }
    const expectedContextId = toAuthenticatedClientMutationContextId({
        scope: ingress.scope,
        principalId: ingress.principalId,
        callerClientId: authority.clientId,
        callerSessionId: authority.sessionId
    });
    if (ingress.contextId !== expectedContextId) {
        throw new NonRetryableException('Authenticated client mutation AppInbox context differs.');
    }
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
        const proof: ClientMutationAuthority = {
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
