import type { ClientStateService, ClientStateWritten } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import { toClientMutationCommand } from '@shared-server/rallar-system/client-state/mutation/client-mutation-command.ts';
import { toConnectClientSessionMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-connect-client-session-mutation-input.ts';
import { toDisconnectClientSessionMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-disconnect-client-session-mutation-input.ts';
import { toExpireClientSessionMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-expire-client-session-mutation-input.ts';
import { toHeartbeatClientSessionMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-heartbeat-client-session-mutation-input.ts';
import { toUpsertClientInstanceMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-upsert-client-instance-mutation-input.ts';
import { toUpsertClientPrincipalMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-upsert-client-principal-mutation-input.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { ConnectClientSessionRequest, DisconnectClientSessionRequest, HeartbeatClientSessionRequest, StateScope } from '@shared/api/state-types.ts';

import type { ClientStatePhaseTestDriver, ClientStateTestAuthorisedWsInput } from './client-state-test-driver-contracts.ts';

export type ClientStateTestMutationExecutor = (
    inputFactory: () => Parameters<typeof toClientMutationCommand>[0]
) => Promise<ClientStateWritten>;

export interface ClientStateTestOperationContext {
    readonly service: ClientStateService;
    readonly execute: ClientStateTestMutationExecutor;
    readonly nextId: () => string;
}

export function createClientStateTestDriverOperations(
    context: ClientStateTestOperationContext
): ClientStatePhaseTestDriver {
    return {
        listSnapshots: context.service.listSnapshots,
        readSnapshot: context.service.readSnapshot,
        readPresenceSnapshot: context.service.readPresenceSnapshot,
        listEvents: context.service.listEvents,
        listEventPage: context.service.listEventPage,
        ...createPrincipalAndInstanceOperations(context),
        ...createSessionOperations(context),
        ...createAuthorisedWsOperations(context),
        expireExpiredSessions: async (atEpochMs) => {
            const page = await context.service.readExpiredSessionPage({
                atEpochMs,
                afterKey: null
            });
            if (page.nextAfterKey !== null) {
                throw new Error('Client state test driver expiry exceeds one bounded page');
            }
            return await Promise.all(
                page.candidates.map(
                    async (candidate) => await context.execute(() => toExpireClientSessionMutationInput(candidate))
                )
            );
        }
    };
}

function createPrincipalAndInstanceOperations(
    context: ClientStateTestOperationContext
): Pick<ClientStatePhaseTestDriver, 'upsertPrincipal' | 'upsertInstance'> {
    return {
        upsertPrincipal: async (scope, principalId, request) =>
            await context.execute(() =>
                toUpsertClientPrincipalMutationInput({
                    scope,
                    principalId,
                    request,
                    defaultCommandId: context.nextId()
                })
            ),
        upsertInstance: async (scope, principalId, clientInstanceId, request) =>
            await context.execute(() =>
                toUpsertClientInstanceMutationInput({
                    scope,
                    principalId,
                    clientInstanceId,
                    request,
                    defaultCommandId: context.nextId()
                })
            )
    };
}

function createSessionOperations(
    context: ClientStateTestOperationContext
): Pick<ClientStatePhaseTestDriver, 'connectSession' | 'heartbeatSession' | 'disconnectSession'> {
    return {
        connectSession: async (scope, principalId, clientInstanceId, sessionId, request) =>
            await executeConnectSession(
                context,
                scope,
                principalId,
                clientInstanceId,
                sessionId,
                request
            ),
        heartbeatSession: async (scope, principalId, clientInstanceId, sessionId, request) =>
            await executeHeartbeatSession(
                context,
                scope,
                principalId,
                clientInstanceId,
                sessionId,
                request
            ),
        disconnectSession: async (scope, principalId, clientInstanceId, sessionId, request) =>
            await executeDisconnectSession(
                context,
                scope,
                principalId,
                clientInstanceId,
                sessionId,
                request
            )
    };
}

async function executeConnectSession(
    context: ClientStateTestOperationContext,
    scope: StateScope,
    principalId: string,
    clientInstanceId: string,
    sessionId: string,
    request: ConnectClientSessionRequest
): Promise<ClientStateWritten> {
    return await context.execute(() =>
        toConnectClientSessionMutationInput({
            operation: 'connectSession',
            scope,
            principalId,
            clientInstanceId,
            sessionId,
            request,
            defaultCommandId: context.nextId(),
            identityDefaults: {}
        })
    );
}

async function executeHeartbeatSession(
    context: ClientStateTestOperationContext,
    scope: StateScope,
    principalId: string,
    clientInstanceId: string,
    sessionId: string,
    request: HeartbeatClientSessionRequest
): Promise<ClientStateWritten> {
    return await context.execute(() =>
        toHeartbeatClientSessionMutationInput({
            scope,
            principalId,
            clientInstanceId,
            sessionId,
            request,
            defaultCommandId: context.nextId()
        })
    );
}

async function executeDisconnectSession(
    context: ClientStateTestOperationContext,
    scope: StateScope,
    principalId: string,
    clientInstanceId: string,
    sessionId: string,
    request: DisconnectClientSessionRequest
): Promise<ClientStateWritten> {
    return await context.execute(() =>
        toDisconnectClientSessionMutationInput({
            operation: 'disconnectSession',
            scope,
            principalId,
            clientInstanceId,
            sessionId,
            request,
            defaultCommandId: context.nextId()
        })
    );
}

function createAuthorisedWsOperations(
    context: ClientStateTestOperationContext
): Pick<ClientStatePhaseTestDriver, 'registerAuthorisedWsClientSession' | 'disconnectAuthorisedWsClientSession'> {
    return {
        registerAuthorisedWsClientSession: async (auth, generationId, input = {}) => await executeAuthorisedWsConnect(context, auth, generationId, input),
        disconnectAuthorisedWsClientSession: async (sessionId, generationId, reason) =>
            await executeAuthorisedWsDisconnect(context, sessionId, generationId, reason)
    };
}

async function executeAuthorisedWsConnect(
    context: ClientStateTestOperationContext,
    auth: AuthSession,
    generationId: string,
    input: ClientStateTestAuthorisedWsInput
): Promise<ClientStateWritten> {
    const scope = {
        applicationId: input.applicationId ?? 'rallar-server',
        workspaceId: input.workspaceId ?? 'default'
    };
    const principalId = input.principalId ?? auth.clientId;
    return await context.execute(() =>
        toConnectClientSessionMutationInput({
            operation: 'connectAuthorisedWsSession',
            scope,
            principalId,
            clientInstanceId: input.clientInstanceId ?? auth.clientId,
            sessionId: auth.sessionId,
            request: toAuthorisedWsConnectRequest(auth, generationId, principalId, input),
            defaultCommandId: context.nextId(),
            identityDefaults: {
                platform: input.platform,
                userAgent: input.userAgent,
                capabilities: input.capabilities,
                principalUsername: auth.username,
                principalDisplayName: input.displayName ?? auth.username,
                principalRoles: ['member']
            }
        })
    );
}

function toAuthorisedWsConnectRequest(
    auth: AuthSession,
    generationId: string,
    principalId: string,
    input: ClientStateTestAuthorisedWsInput
): ConnectClientSessionRequest {
    return {
        generationId,
        transport: 'ws',
        connectionId: generationId,
        connectedAtEpochMs: input.connectedAtEpochMs,
        expiresAtEpochMs: input.expiresAtEpochMs ?? auth.expiresAtEpochMs,
        actorPrincipalId: principalId,
        actorSessionId: auth.sessionId,
        requestId: `authorised-ws:connect:${auth.sessionId}:${generationId}`
    };
}

async function executeAuthorisedWsDisconnect(
    context: ClientStateTestOperationContext,
    sessionId: string,
    generationId: string,
    reason?: string
): Promise<ClientStateWritten> {
    const session = await context.service.findSessionBySessionId(sessionId);
    if (!session) {
        throw new Error(`Durable client connection generation not found: ${sessionId}`);
    }
    return await context.execute(() =>
        toDisconnectClientSessionMutationInput({
            operation: 'disconnectAuthorisedWsSession',
            scope: { applicationId: session.applicationId, workspaceId: session.workspaceId },
            principalId: session.principalId,
            clientInstanceId: session.clientInstanceId,
            sessionId,
            request: {
                generationId,
                reason,
                actorPrincipalId: session.principalId,
                actorSessionId: sessionId,
                requestId: `authorised-ws:disconnect:${sessionId}:${generationId}`
            },
            defaultCommandId: context.nextId()
        })
    );
}
