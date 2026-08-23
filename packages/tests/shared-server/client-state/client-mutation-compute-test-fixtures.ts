import {
    toClientMutationIssuedSessionAuthority,
    toClientMutationSystemAuthority
} from '@shared-server/rallar-system/client-state/mutation/client-mutation-authority.ts';
import {
    toClientMutationCommand,
    toConnectCommandInput,
    toDisconnectCommandInput,
    toExpiryCommandInput,
    toHeartbeatCommandInput,
    toUpsertInstanceCommandInput,
    toUpsertPrincipalCommandInput
} from '@shared-server/rallar-system/client-state/mutation/client-mutation-command.ts';
import type {
    ClientMutationCommand,
    ClientMutationCommandInput,
    ClientMutationComputedAppliedWrite,
    ClientMutationRead
} from '@shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts';
import type { RuntimeStateEntryValue } from '@shared-server/runtime-state/RuntimeStateJsonStore.ts';
import type { ClientInstance, ClientPrincipal, ClientSession } from '@shared/api/client-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';

export const TEST_SCOPE: StateScope = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1'
};

export async function principalCommand(
    commandId = 'principal-1',
    displayName: string | undefined = 'Alice'
): Promise<ClientMutationCommand> {
    return await command(
        toUpsertPrincipalCommandInput(
            TEST_SCOPE,
            'alice',
            {
                username: 'alice',
                displayName,
                roles: ['member'],
                metadata: { theme: 'dark' },
                requestId: commandId
            },
            commandId
        )
    );
}

export async function instanceCommand(commandId = 'instance-1'): Promise<ClientMutationCommand> {
    return await command(
        toUpsertInstanceCommandInput(
            TEST_SCOPE,
            'alice',
            'browser',
            {
                platform: 'web',
                deviceLabel: 'Laptop',
                capabilities: ['rtc'],
                requestId: commandId
            },
            commandId
        )
    );
}

export async function connectCommand(
    commandId = 'connect-1',
    generationId = 'generation-1',
    connectedAtEpochMs = 2_000
): Promise<ClientMutationCommand> {
    return await command(
        toConnectCommandInput(
            'connectSession',
            TEST_SCOPE,
            'alice',
            'browser',
            'session-1',
            {
                generationId,
                connectedAtEpochMs,
                expiresAtEpochMs: 8_000,
                requestId: commandId
            },
            commandId,
            { platform: 'web', principalUsername: 'alice' }
        )
    );
}

export async function heartbeatCommand(
    commandId = 'heartbeat-1',
    generationId = 'generation-1'
): Promise<ClientMutationCommand> {
    return await command(
        toHeartbeatCommandInput(
            TEST_SCOPE,
            'alice',
            'browser',
            'session-1',
            {
                generationId,
                presenceState: 'away',
                lastHeartbeatAtEpochMs: 3_000,
                expiresAtEpochMs: 9_000,
                requestId: commandId
            },
            commandId
        ),
        3_000
    );
}

export async function disconnectCommand(
    commandId = 'disconnect-1',
    generationId = 'generation-1'
): Promise<ClientMutationCommand> {
    return await command(
        toDisconnectCommandInput(
            'disconnectSession',
            TEST_SCOPE,
            'alice',
            'browser',
            'session-1',
            {
                generationId,
                disconnectedAtEpochMs: 4_000,
                reason: 'closed',
                requestId: commandId
            },
            commandId
        ),
        4_000
    );
}

export async function expiryCommand(
    commandId = 'expire-client-session:session-1:generation-1:1:8000'
): Promise<ClientMutationCommand> {
    const input = toExpiryCommandInput({
        ...TEST_SCOPE,
        principalId: 'alice',
        clientInstanceId: 'browser',
        sessionId: 'session-1',
        generationId: 'generation-1',
        generationVersion: 1,
        observedExpiresAtEpochMs: 8_000
    });
    return await command({ ...input, commandId, requestId: commandId }, 8_000);
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
        receiptEvent: null
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

async function command(
    input: ClientMutationCommandInput,
    nowEpochMs = 1_000
): Promise<ClientMutationCommand> {
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
    return await toClientMutationCommand(
        input,
        {
            nowEpochMs,
            serviceId: 'client-service',
            eventId: `event:${input.commandId}`,
            attemptCount: 1,
            expireAtEpochMs: 20_000
        },
        authority
    );
}
