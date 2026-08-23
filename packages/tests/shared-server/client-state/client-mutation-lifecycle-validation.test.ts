import { createClientStateService as createClientMutationService } from '@shared-server/rallar-system/client-state/client-state-service.ts';
import { ClientMutationRejectedError } from '@shared-server/rallar-system/client-state/client-state-validation-primitives.ts';
import { toClientMutationSystemAuthority } from '@shared-server/rallar-system/client-state/mutation/client-mutation-authority.ts';
import { toClientMutationCommand, toExpiryCommandInput } from '@shared-server/rallar-system/client-state/mutation/client-mutation-command.ts';
import {
    type ClientMutationAuthority,
    type ClientMutationCommand,
    type ClientMutationFacts,
    type ClientMutationOperation,
    type ClientMutationRead
} from '@shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts';
import { validateClientMutationCommand } from '@shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-command.ts';
import { computeClientMutation } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts';
import { validateClientMutation } from '@shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation.ts';
import { ClientMutationIdempotencyConflictError } from '@shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation.ts';
import {
    ClientStateRepository,
    ClientStateRepositoryInvariantCorruptionError
} from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';
import {
    clientStateInstanceStorageKey,
    clientStatePrincipalStorageKey,
    clientStateSessionStorageKey,
    decodeClientPrincipalStorageKey
} from '@shared-server/rallar-system/client-state/persistence/client-state-storage-keys.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { toClientSessionExpiryCandidate } from '@shared-server/rallar-system/presence/session-expiry.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import type {
    RuntimeStateConditionalWriteResult,
    RuntimeStateEntry,
    RuntimeStateOptimisticTransactionalRepositoryLike
} from '@shared-server/runtime-state/runtime-state-repository.ts';
import type { ClientPrincipalRef, ClientSession } from '@shared/api/client-types.ts';
import type { ConnectClientSessionRequest, StateScope } from '@shared/api/state-types.ts';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { FakeRuntimeStateRepository } from '../fake-runtime-state-repository.ts';
import {
    AggregateBarrierRepository,
    AlwaysConflictingPrincipalRepository,
    CLIENT_MUTATION_BASE_EPOCH_MS as BASE_EPOCH_MS,
    connect,
    createService,
    deepFreeze,
    outboxFor,
    PrincipalChangeAfterFirstReadRepository,
    snapshot,
    StatementRecordingRepository
} from './client-mutation-concurrency-test-runtime.ts';
import {
    CLIENT_MUTATION_TEST_SCOPE as SCOPE,
    clientMutationPrincipalRef as principalRef,
    emptyClientMutationRead,
    invalidSessionCommand,
    validAuthoritySession,
    validFacts,
    validPrincipalCommand,
    validPrincipalValue
} from './client-mutation-validation-test-fixtures.ts';
import {
    createClientStateTestDriver as createClientStateService,
    failNextClientStateTestOutboxWrite,
    getClientStateTestOutbox
} from './client-state-test-runtime.ts';

describe('client mutation lifecycle validation', () => {
    it('rejects causally impossible lifecycle timestamps in commands, stored reads, and computed state', async () => {
        expectInvalidLifecycleCommands();
        expectCorruptReadAndComputedRejection();
        await expectMalformedHeartbeatRejection();
        await expectCorruptStoredSessionRejection();
    });
});

const lifecycleBase = {
    aggregateRef: principalRef('alice'),
    commandId: 'causal-command',
    requestId: 'causal-command',
    facts: validFacts()
} as const;
const lifecycleActor = {
    actorPrincipalId: null,
    actorSessionId: null,
    reason: null,
    traceId: null
} as const;

function expectInvalidLifecycleCommands(): void {
    const invalidCommands = [
        invalidSessionCommand(lifecycleBase, lifecycleActor, 'connectSession', {
            authenticatedAtEpochMs: 1_001,
            connectedAtEpochMs: 1_000
        }),
        invalidSessionCommand(lifecycleBase, lifecycleActor, 'connectSession', {
            connectedAtEpochMs: 1_001,
            lastHeartbeatAtEpochMs: 1_000
        }),
        invalidSessionCommand(lifecycleBase, lifecycleActor, 'heartbeatSession', {
            lastHeartbeatAtEpochMs: 2_001,
            expiresAtEpochMs: 2_000
        }),
        invalidSessionCommand(lifecycleBase, lifecycleActor, 'disconnectSession', {
            disconnectedAtEpochMs: 999,
            lastHeartbeatAtEpochMs: 1_000
        }),
        invalidSessionCommand(lifecycleBase, lifecycleActor, 'expireSession', {
            observedExpiresAtEpochMs: 2_001,
            expiresAtEpochMs: 2_000
        })
    ];
    for (const command of invalidCommands) {
        let error: unknown;
        try {
            validateClientMutationCommand(command);
        }
        catch (caught) {
            error = caught;
        }
        expect(error).toMatchObject({ code: 'client-mutation-rejected', status: 400 });
    }
}

function expectCorruptReadAndComputedRejection(): void {
    const validConnect = validConnectCommand();
    const computed = computeClientMutation({
        command: validConnect,
        read: emptyClientMutationRead()
    });
    expect(computed.outcome).toBe('write');
    if (computed.outcome !== 'write' || computed.session.operation === 'none') {
        throw new Error('Expected a session write');
    }
    const corruptSession = {
        ...computed.session.value,
        expiresAtEpochMs: computed.session.value.lastHeartbeatAtEpochMs - 1
    };
    expect(() =>
        computeClientMutation({
            command: heartbeatCorruptCommand(),
            read: {
                authoritySession: validAuthoritySession('session-1'),
                idempotency: null,
                principal: storedEntry(computed.principal.value) as never,
                instance: computed.instance.operation === 'none'
                    ? null
                    : (storedEntry(computed.instance.value) as never),
                session: storedEntry(corruptSession) as never,
                expiredSessionEntry: null,
                snapshot: computed.snapshot,
                receiptEvent: null
            }
        })
    ).toThrow(ClientMutationRejectedError);
    expectCorruptComputedRejection(validConnect, computed);
}

function expectCorruptComputedRejection(
    command: ClientMutationCommand,
    computed: ReturnType<typeof computeClientMutation>
): void {
    const invalidComputed = structuredClone(computed);
    if (invalidComputed.outcome !== 'write' || invalidComputed.session.operation === 'none') {
        throw new Error('Expected a session write');
    }
    const invalidSessionComputed = {
        ...invalidComputed,
        session: {
            ...invalidComputed.session,
            value: {
                ...invalidComputed.session.value,
                expiresAtEpochMs: invalidComputed.session.value.lastHeartbeatAtEpochMs - 1
            }
        }
    };
    expect(() =>
        validateClientMutation({
            command,
            read: emptyClientMutationRead(),
            computed: invalidSessionComputed
        })
    ).toThrow(ClientMutationRejectedError);
}

async function expectMalformedHeartbeatRejection(): Promise<void> {
    const runtime = new AggregateBarrierRepository();
    await expect(
        createService(runtime, 1_000).heartbeatSession(SCOPE, 'alice', 'browser', 'session-1', {
            generationId: 'generation-1',
            lastHeartbeatAtEpochMs: 2_001,
            expiresAtEpochMs: 2_000,
            requestId: 'malformed-heartbeat'
        })
    ).rejects.toMatchObject({ status: 400 });
    expect([...runtime.data.keys()].filter((key) => key.startsWith('client-state:'))).toEqual([]);
}

async function expectCorruptStoredSessionRejection(): Promise<void> {
    const runtime = new AggregateBarrierRepository();
    await connect(runtime, 'corrupt-session', 'corrupt-generation', BASE_EPOCH_MS);
    const storedSession = [...runtime.data.entries()].find(([, stored]) => {
        try {
            return JSON.parse(stored.value).generationId === 'corrupt-generation';
        }
        catch {
            return false;
        }
    });
    if (!storedSession) {
        throw new Error('Expected stored client session');
    }
    const corruptValue = JSON.parse(storedSession[1].value);
    corruptValue.expiresAtEpochMs = corruptValue.lastHeartbeatAtEpochMs - 1;
    runtime.data.set(storedSession[0], {
        ...storedSession[1],
        value: JSON.stringify(corruptValue)
    });
    const corruptBefore = structuredClone([...runtime.data.entries()]);
    await expect(
        createService(runtime, BASE_EPOCH_MS + 1_000).heartbeatSession(
            SCOPE,
            'alice',
            'browser',
            'corrupt-session',
            {
                generationId: 'corrupt-generation',
                lastHeartbeatAtEpochMs: BASE_EPOCH_MS + 1_000,
                expiresAtEpochMs: BASE_EPOCH_MS + 60_000,
                requestId: 'reject-corrupt-stored-session'
            }
        )
    ).rejects.toBeInstanceOf(ClientStateRepositoryInvariantCorruptionError);
    expect([...runtime.data.entries()]).toEqual(corruptBefore);
}

function validConnectCommand(): ClientMutationCommand {
    return invalidSessionCommand(
        { ...lifecycleBase, commandId: 'valid-connect', requestId: 'valid-connect' },
        lifecycleActor,
        'connectSession',
        {}
    ) as ClientMutationCommand;
}

function heartbeatCorruptCommand(): ClientMutationCommand {
    return invalidSessionCommand(
        { ...lifecycleBase, commandId: 'heartbeat-corrupt', requestId: 'heartbeat-corrupt' },
        lifecycleActor,
        'heartbeatSession',
        {}
    ) as ClientMutationCommand;
}

function storedEntry(value: unknown) {
    return {
        entry: {
            key: 'stored',
            value: JSON.stringify(value),
            expireAtTimestamp: 10_000,
            updatedTimestamp: '2026-07-19T00:00:00.000Z',
            revision: 0
        },
        value
    };
}
