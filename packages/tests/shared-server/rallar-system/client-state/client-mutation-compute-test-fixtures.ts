import { Temporal } from '@js-temporal/polyfill';

import { toAuthorisedWsClientConnection } from '@shared-server/rallar-system/client-state/inbox/authorised-ws-client-app-inbox.ts';
import type { ComputeAuthorisedWsConnectOperationInput } from '@shared-server/rallar-system/client-state/inbox/client-state-inbox-computation.ts';
import {
    toClientMutationIssuedSessionAuthority,
    toClientMutationSystemAuthority
} from '@shared-server/rallar-system/client-state/mutation/client-mutation-authority.ts';
import { toClientMutationCommand } from '@shared-server/rallar-system/client-state/mutation/client-mutation-command.ts';
import type {
    ClientMutationCommand,
    ClientMutationCommandInput,
    ClientMutationComputedAppliedWrite,
    ClientMutationRead
} from '@shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts';
import { toConnectClientSessionMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-connect-client-session-mutation-input.ts';
import { toDisconnectClientSessionMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-disconnect-client-session-mutation-input.ts';
import { toExpireClientSessionMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-expire-client-session-mutation-input.ts';
import { toHeartbeatClientSessionMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-heartbeat-client-session-mutation-input.ts';
import { toUpsertClientInstanceMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-upsert-client-instance-mutation-input.ts';
import { toUpsertClientPrincipalMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-upsert-client-principal-mutation-input.ts';
import { toWsSessionLifecycleKey } from '@shared-server/rallar-system/websocket/ws-session-generation-computation.ts';
import type { RuntimeStateEntryValue } from '@shared-server/runtime-state/runtime-state-json-store.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { ClientInstance, ClientPrincipal, ClientSession } from '@shared/api/client-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { EntityStatus, NEVER_EXPIRE_TS, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { TEST_DISCONNECTED_SESSION_RETENTION_MS } from './test-disconnected-session-retention.ts';

export const TEST_SCOPE: StateScope = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1'
};

export function principalCommand(
    commandId = 'principal-1',
    displayName: string | undefined = 'Alice'
): ClientMutationCommand {
    return command(
        toUpsertClientPrincipalMutationInput({
            scope: TEST_SCOPE,
            principalId: 'alice',
            request: {
                username: 'alice',
                displayName,
                roles: ['member'],
                metadata: { theme: 'dark' },
                requestId: commandId
            },
            defaultCommandId: commandId
        })
    );
}

export function instanceCommand(commandId = 'instance-1'): ClientMutationCommand {
    return command(
        toUpsertClientInstanceMutationInput({
            scope: TEST_SCOPE,
            principalId: 'alice',
            clientInstanceId: 'browser',
            request: {
                platform: 'web',
                deviceLabel: 'Laptop',
                capabilities: ['rtc'],
                requestId: commandId
            },
            defaultCommandId: commandId
        })
    );
}

export function connectCommand(
    commandId = 'connect-1',
    generationId = 'generation-1',
    connectedAtEpochMs = 2_000
): ClientMutationCommand {
    return command(
        toConnectClientSessionMutationInput({
            operation: 'connectSession',
            scope: TEST_SCOPE,
            principalId: 'alice',
            clientInstanceId: 'browser',
            sessionId: 'session-1',
            request: {
                generationId,
                connectedAtEpochMs,
                expiresAtEpochMs: 8_000,
                requestId: commandId
            },
            defaultCommandId: commandId,
            identityDefaults: { platform: 'web', principalUsername: 'alice' }
        })
    );
}

export function heartbeatCommand(
    commandId = 'heartbeat-1',
    generationId = 'generation-1'
): ClientMutationCommand {
    return command(
        toHeartbeatClientSessionMutationInput({
            scope: TEST_SCOPE,
            principalId: 'alice',
            clientInstanceId: 'browser',
            sessionId: 'session-1',
            request: {
                generationId,
                presenceState: 'away',
                lastHeartbeatAtEpochMs: 3_000,
                expiresAtEpochMs: 9_000,
                requestId: commandId
            },
            defaultCommandId: commandId
        }),
        3_000
    );
}

export function disconnectCommand(
    commandId = 'disconnect-1',
    generationId = 'generation-1'
): ClientMutationCommand {
    return command(
        toDisconnectClientSessionMutationInput({
            operation: 'disconnectSession',
            scope: TEST_SCOPE,
            principalId: 'alice',
            clientInstanceId: 'browser',
            sessionId: 'session-1',
            request: {
                generationId,
                disconnectedAtEpochMs: 4_000,
                reason: 'closed',
                requestId: commandId
            },
            defaultCommandId: commandId
        }),
        4_000
    );
}

export function expiryCommand(
    commandId = 'expire-client-session:session-1:generation-1:1:8000'
): ClientMutationCommand {
    const input = toExpireClientSessionMutationInput({
        ...TEST_SCOPE,
        principalId: 'alice',
        clientInstanceId: 'browser',
        sessionId: 'session-1',
        generationId: 'generation-1',
        generationVersion: 1,
        observedExpiresAtEpochMs: 8_000
    });
    return command({ ...input, commandId, requestId: commandId }, 8_000);
}

export function authorisedConnectOperationInput(): ComputeAuthorisedWsConnectOperationInput {
    const authSession = {
        clientId: 'alice',
        username: 'alice',
        sessionId: 'session-1',
        accessToken: 'test-token',
        issuedAtEpochMs: 0,
        expiresAtEpochMs: 10_000
    };
    const connection = toAuthorisedWsClientConnection({
        authSession,
        generationId: 'generation-1',
        input: { ...TEST_SCOPE, clientInstanceId: 'browser', connectedAtEpochMs: 2_000, expiresAtEpochMs: 8_000 }
    });
    const requestId = `authorised-ws:connect:${authSession.sessionId}:${connection.generationId}`;
    const command = toClientMutationCommand(
        toConnectClientSessionMutationInput({
            operation: 'connectAuthorisedWsSession',
            scope: TEST_SCOPE,
            principalId: connection.principalId,
            clientInstanceId: connection.clientInstanceId,
            sessionId: authSession.sessionId,
            request: {
                generationId: connection.generationId,
                presenceState: 'online',
                transport: 'ws',
                connectionId: connection.generationId,
                connectedAtEpochMs: connection.generationStartedAtEpochMs,
                expiresAtEpochMs: connection.expiresAtEpochMs,
                actorPrincipalId: connection.principalId,
                actorSessionId: authSession.sessionId,
                requestId
            },
            defaultCommandId: requestId,
            identityDefaults: { platform: connection.platform, principalUsername: authSession.username }
        }),
        {
            nowEpochMs: 1_000,
            serviceId: 'client-service',
            eventId: `event:${requestId}`,
            attemptCount: 1,
            expireAtEpochMs: 20_000,
            disconnectedSessionRetentionMs: TEST_DISCONNECTED_SESSION_RETENTION_MS
        },
        toClientMutationIssuedSessionAuthority(authSession, TEST_SCOPE, 'connectAuthorisedWsSession')
    );
    const identity = {
        scope: { kind: 'client', ...TEST_SCOPE, principalId: 'alice', clientInstanceId: 'browser' },
        sessionId: authSession.sessionId
    } as const;
    const ticket = {
        ticketDigest: 'alice-ticket-digest',
        accessTokenDigest: 'alice-access-digest',
        sessionId: authSession.sessionId,
        clientId: authSession.clientId,
        issuedAtEpochMs: 1_500,
        expiresAtEpochMs: 9_000
    };
    const session = {
        clientId: authSession.clientId,
        username: authSession.username,
        sessionId: authSession.sessionId,
        accessTokenDigest: ticket.accessTokenDigest,
        issuedAtEpochMs: authSession.issuedAtEpochMs,
        expiresAtEpochMs: authSession.expiresAtEpochMs
    };
    return {
        connection,
        ticketClaim: {
            ticketDigest: ticket.ticketDigest,
            clientId: authSession.clientId,
            sessionId: authSession.sessionId,
            sessionIssuedAtEpochMs: authSession.issuedAtEpochMs,
            sessionExpiresAtEpochMs: authSession.expiresAtEpochMs,
            capturedAtEpochMs: 2_000
        },
        ticketRead: {
            ticket: entryValue(ticket, 0),
            session: entryValue(session, 0)
        },
        command,
        read: emptyRead(command),
        lifecycleFacts: {
            ...identity,
            generationId: connection.generationId,
            generationStartedAtEpochMs: connection.generationStartedAtEpochMs
        },
        lifecycleRead: {
            identity,
            key: toWsSessionLifecycleKey(identity),
            revision: null,
            persistedExpireAtEpochMs: null,
            state: null
        },
        completionFacts: { entry: completionEntry(), completedAtEpochMs: 8_000 }
    };
}

export function emptyRead(command: ClientMutationCommand): ClientMutationRead {
    return {
        authoritySession: command.authority.kind === 'issued-session'
            ? {
                clientId: command.authority.principalId,
                username: command.authority.principalId,
                sessionId: command.authority.sessionId,
                accessTokenDigest: 'sha256:test-token',
                issuedAtEpochMs: command.authority.sessionIssuedAtEpochMs,
                expiresAtEpochMs: command.authority.sessionExpiresAtEpochMs
            }
            : null,
        idempotency: null,
        principal: null,
        instance: null,
        session: null,
        expiredSessionEntry: null,
        snapshot: null,
        receiptEvent: null,
        audienceObservedAtEpochMs: command.facts.nowEpochMs,
        audienceGroupSnapshots: [],
        audienceCoMemberSessions: []
    };
}

export function readAfterWrite(
    command: ClientMutationCommand,
    computed: ClientMutationComputedAppliedWrite
): ClientMutationRead {
    return {
        ...emptyRead(command),
        principal: entryValue(computed.principal.value, 1),
        instance: computed.instance.operation === 'none' ? null : entryValue(computed.instance.value, 1),
        session: computed.session.operation === 'none' ? null : entryValue(computed.session.value, 1),
        snapshot: computed.snapshot,
        receiptEvent: computed.event
    };
}

export function entryValue<T>(value: T, revision: number): RuntimeStateEntryValue<T> {
    return {
        entry: {
            key: `test-key:${revision}`,
            value: JSON.stringify(value),
            expireAtTimestamp: 20_000,
            updatedTimestamp: '1970-01-01T00:00:00.000Z',
            revision
        },
        value
    };
}

export function requireWrite(
    computed: ReturnType<typeof import('@shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts').computeClientMutation>
): ClientMutationComputedAppliedWrite {
    if (computed.outcome !== 'write') {
        throw new Error(`Expected client mutation write, received ${computed.outcome}`);
    }
    return computed;
}

export function principalFrom(computed: ClientMutationComputedAppliedWrite): ClientPrincipal {
    return computed.principal.value;
}

export function instanceFrom(computed: ClientMutationComputedAppliedWrite): ClientInstance {
    if (computed.instance.operation === 'none') {
        throw new Error('Expected instance candidate');
    }
    return computed.instance.value;
}

export function sessionFrom(computed: ClientMutationComputedAppliedWrite): ClientSession {
    if (computed.session.operation === 'none') {
        throw new Error('Expected session candidate');
    }
    return computed.session.value;
}

function command(
    input: ClientMutationCommandInput,
    nowEpochMs = 1_000
): ClientMutationCommand {
    const authority = input.operation === 'expireSession'
        ? toClientMutationSystemAuthority('client-service')
        : toClientMutationIssuedSessionAuthority(
            {
                clientId: input.aggregateRef.principalId,
                username: input.aggregateRef.principalId,
                sessionId: 'sessionId' in input ? input.sessionId : 'authority-session',
                accessTokenDigest: 'sha256:test-token',
                issuedAtEpochMs: 0,
                expiresAtEpochMs: 10_000
            },
            input.aggregateRef,
            input.operation
        );
    return toClientMutationCommand(
        input,
        {
            nowEpochMs,
            serviceId: 'client-service',
            eventId: `event:${input.commandId}`,
            attemptCount: 1,
            expireAtEpochMs: 20_000,
            disconnectedSessionRetentionMs: TEST_DISCONNECTED_SESSION_RETENTION_MS
        },
        authority
    );
}

function completionEntry(): ResourceEntry {
    return {
        key: { topicId: 'app-inbox.client-state', resourceId: 'authorised-connect', contextId: 'client-state' },
        resource: '{}',
        typeId: EnqueuedType.APP_INBOX,
        audit: {
            date: Temporal.PlainTime.from('00:00:01'),
            createdBy: 'client-service',
            createdTs: Temporal.PlainDateTime.from('1970-01-01T00:00:01'),
            expiryTs: NEVER_EXPIRE_TS
        },
        status: EntityStatus.RESERVED,
        dequeueAudit: { attempts: 1 }
    };
}
