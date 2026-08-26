import { createClientStateService as createClientMutationService } from '@shared-server/rallar-system/client-state/client-state-service.ts';
import { toClientMutationSystemAuthority } from '@shared-server/rallar-system/client-state/mutation/client-mutation-authority.ts';
import { toClientMutationCommand } from '@shared-server/rallar-system/client-state/mutation/client-mutation-command.ts';
import {
    type ClientMutationAuthority,
    type ClientMutationCommand,
    type ClientMutationFacts,
    type ClientMutationOperation,
    type ClientMutationRead
} from '@shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts';
import { toExpireClientSessionMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-expire-client-session-mutation-input.ts';
import { validateClientMutationCommand } from '@shared-server/rallar-system/client-state/mutation/command-validation/validate-client-mutation-command.ts';
import { computeClientMutation } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts';
import { validateClientMutation } from '@shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation.ts';
import { ClientMutationIdempotencyConflictError } from '@shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation.ts';
import { clientStateInstanceStorageKey } from '@shared-server/rallar-system/client-state/persistence/client-state-instance-storage-key.ts';
import { ClientStateRepositoryInvariantCorruptionError } from '@shared-server/rallar-system/client-state/persistence/client-state-persistence-contracts.ts';
import {
    clientStatePrincipalStorageKey,
    decodeClientPrincipalStorageKey
} from '@shared-server/rallar-system/client-state/persistence/client-state-principal-storage-key.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';
import { clientStateSessionStorageKey } from '@shared-server/rallar-system/client-state/persistence/client-state-session-storage-key.ts';
import { ClientMutationRejectedError } from '@shared-server/rallar-system/client-state/validation/client-mutation-rejection.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { toClientSessionExpiryCandidate } from '@shared-server/rallar-system/presence/session-expiry.ts';
import { decodeJsonWireValue, type JsonWireObject, type JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import type { RuntimeStateReadBatchSelection, RuntimeStateReadBatchSelector } from '@shared-server/runtime-state/read-batch/runtime-state-read-batch.ts';
import type {
    RuntimeStateConditionalWriteResult,
    RuntimeStateEntry,
    RuntimeStateOptimisticTransactionalRepositoryLike
} from '@shared-server/runtime-state/runtime-state-repository.ts';
import { createTestClientStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { TestClientStateEventStore } from '@shared-test/shared-server/test-client-state-event-store.ts';
import type { ClientEvent, ClientPrincipalRef, ClientSession } from '@shared/api/client-types.ts';
import type { ConnectClientSessionRequest, StateScope } from '@shared/api/state-types.ts';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';
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

describe('client mutation persisted-state validation', () => {
    it('fails closed when a direct persisted principal read omits its workspace identity', async () => {
        const runtime = new AggregateBarrierRepository();
        await connect({ runtime, sessionId: 'principal-session', generationId: 'principal-generation', nowEpochMs: BASE_EPOCH_MS });
        await removePersistedWorkspaceId(runtime, 'client-state:principals');

        await expect(
            createTestClientStateRepository(runtime).findPrincipal(principalRef('alice'))
        ).rejects.toBeInstanceOf(ClientStateRepositoryInvariantCorruptionError);
    });

    it('fails closed when a persisted instance list entry omits its workspace identity', async () => {
        const runtime = new AggregateBarrierRepository();
        await connect({ runtime, sessionId: 'instance-session', generationId: 'instance-generation', nowEpochMs: BASE_EPOCH_MS });
        await removePersistedWorkspaceId(runtime, 'client-state:instances');

        await expect(
            createTestClientStateRepository(runtime).listInstances(principalRef('alice'))
        ).rejects.toBeInstanceOf(ClientStateRepositoryInvariantCorruptionError);
    });

    it('fails closed when a persisted session snapshot entry omits its workspace identity', async () => {
        const runtime = new AggregateBarrierRepository();
        await connect({ runtime, sessionId: 'snapshot-session', generationId: 'snapshot-generation', nowEpochMs: BASE_EPOCH_MS });
        await removePersistedWorkspaceId(runtime, 'client-state:sessions');

        await expect(
            createTestClientStateRepository(runtime).readSnapshot(principalRef('alice'))
        ).rejects.toBeInstanceOf(ClientStateRepositoryInvariantCorruptionError);
    });

    it('fails closed when a persisted event read omits its workspace identity', async () => {
        const runtime = new AggregateBarrierRepository();
        const eventStore = new TestClientStateEventStore();
        eventStore.events.push({
            applicationId: SCOPE.applicationId,
            principalId: 'alice',
            eventId: 'event-without-workspace',
            eventType: 'session-connected',
            clientInstanceId: 'browser',
            sessionId: 'event-session',
            snapshotVersion: 1,
            occurredAtEpochMs: BASE_EPOCH_MS,
            actor: { kind: 'service', serviceId: 'client-test' },
            reason: null,
            traceId: null,
            requestId: null,
            payload: {}
        } as ClientEvent);
        vi.spyOn(eventStore, 'listClientEvents').mockResolvedValue(eventStore.events);

        await expect(
            createTestClientStateRepository(runtime, eventStore).listEvents(principalRef('alice'))
        ).rejects.toBeInstanceOf(ClientStateRepositoryInvariantCorruptionError);
    });

    it('fails closed when an active persisted session has no matching instance', async () => {
        const runtime = new AggregateBarrierRepository();
        await connect({ runtime, sessionId: 'orphan-session', generationId: 'orphan-generation', nowEpochMs: BASE_EPOCH_MS });
        const [instance] = await runtime.findAllEntries('client-state:instances');
        if (!instance) {
            throw new Error('Expected a stored client instance');
        }
        await runtime.deleteByKey('client-state:instances', instance.key);

        await expect(
            createTestClientStateRepository(runtime).readSnapshot(principalRef('alice'))
        ).rejects.toBeInstanceOf(ClientStateRepositoryInvariantCorruptionError);
    });

    it('fails closed when persisted active session ids collide across instances', async () => {
        const runtime = new AggregateBarrierRepository();
        await connect({ runtime, sessionId: 'shared-session', generationId: 'browser-generation', nowEpochMs: BASE_EPOCH_MS });
        await createService(runtime, BASE_EPOCH_MS + 1).upsertInstance(SCOPE, 'alice', 'phone', {
            platform: 'web',
            requestId: 'register-phone'
        });
        const repository = createTestClientStateRepository(runtime);
        const browserSession = await repository.findSession({
            ...principalRef('alice'),
            clientInstanceId: 'browser',
            sessionId: 'shared-session'
        });
        if (!browserSession) {
            throw new Error('Expected a stored client session');
        }
        await repository.insertSession({
            ...browserSession,
            clientInstanceId: 'phone',
            generationId: 'phone-generation',
            connectionId: null
        });

        await expect(repository.readSnapshot(principalRef('alice'))).rejects.toBeInstanceOf(
            ClientStateRepositoryInvariantCorruptionError
        );
    });

    it('fails closed when a persistence list repeats a client instance', async () => {
        const runtime = new DuplicatingClientInstanceRepository();
        await connect({ runtime, sessionId: 'instance-session', generationId: 'instance-generation', nowEpochMs: BASE_EPOCH_MS });

        await expect(
            createTestClientStateRepository(runtime).readSnapshot(principalRef('alice'))
        ).rejects.toBeInstanceOf(ClientStateRepositoryInvariantCorruptionError);
    });

    it('rejects malformed persisted applied receipt revision and outbox correlations on replay', async () => {
        const request = {
            username: 'alice',
            displayName: 'Alice',
            requestId: 'malformed-applied-replay'
        } as const;

        for (
            const variant of [
                'missing-revision',
                'divergent-revision',
                'missing-outbox',
                'wrong-outbox'
            ] as const
        ) {
            const runtime = new AggregateBarrierRepository();
            const service = createService(runtime, 1_000);
            await service.upsertPrincipal(SCOPE, 'alice', request);
            const repository = createTestClientStateRepository(runtime);
            const stored = await repository.findIdempotentClientMutationReceipt(
                principalRef('alice'),
                request.requestId
            );
            if (!stored) {
                throw new Error('Expected an applied client receipt');
            }
            const [entry] = await runtime.findAllEntries('client-state:idempotent');
            if (!entry) {
                throw new Error('Expected a persisted client receipt');
            }
            const malformed = {
                ...stored,
                receipt: {
                    ...stored.receipt,
                    acceptedStorageRevision: variant === 'missing-revision'
                        ? null
                        : variant === 'divergent-revision'
                        ? (stored.receipt.acceptedStorageRevision ?? 0) + 1
                        : stored.receipt.acceptedStorageRevision,
                    outboxIds: variant === 'missing-outbox'
                        ? []
                        : variant === 'wrong-outbox'
                        ? ['wrong-outbox']
                        : stored.receipt.outboxIds
                }
            };
            await runtime.upsert(
                'client-state:idempotent',
                entry.key,
                JSON.stringify(malformed),
                Number.MAX_SAFE_INTEGER
            );

            await expect(
                repository.findIdempotentClientMutationReceipt(principalRef('alice'), request.requestId),
                variant
            ).rejects.toBeInstanceOf(ClientStateRepositoryInvariantCorruptionError);
            await expect(
                service.upsertPrincipal(SCOPE, 'alice', request),
                `replay ${variant}`
            ).rejects.toBeInstanceOf(ClientStateRepositoryInvariantCorruptionError);
        }
    });

    it('rejects malformed persisted no-op receipt revision and outbox correlations on replay', async () => {
        for (const variant of malformedNoOpVariants) {
            const runtime = new AggregateBarrierRepository();
            const service = createService(runtime, 1_000);
            await service.upsertPrincipal(SCOPE, 'alice', {
                ...malformedNoOpRequest,
                requestId: 'seed-malformed-no-op-replay'
            });
            await service.upsertPrincipal(SCOPE, 'alice', malformedNoOpRequest);
            const repository = createTestClientStateRepository(runtime);
            const stored = await repository.findIdempotentClientMutationReceipt(
                principalRef('alice'),
                malformedNoOpRequest.requestId
            );
            expect(stored?.receipt).toMatchObject({
                outcome: 'no-op',
                acceptedStorageRevision: 0,
                eventId: null,
                outboxIds: []
            });
            if (!stored) {
                throw new Error('Expected a no-op client receipt');
            }
            const entry = (await runtime.findAllEntries('client-state:idempotent')).find((candidate) =>
                candidate.value.includes(malformedNoOpRequest.requestId)
            );
            if (!entry) {
                throw new Error('Expected a persisted no-op client receipt');
            }
            const malformed = {
                ...stored,
                receipt: {
                    ...stored.receipt,
                    acceptedStorageRevision: variant === 'missing-revision'
                        ? null
                        : variant === 'divergent-revision'
                        ? (stored.receipt.acceptedStorageRevision ?? 0) + 1
                        : stored.receipt.acceptedStorageRevision,
                    outboxIds: variant === 'unexpected-outbox' ? ['unexpected-outbox'] : stored.receipt.outboxIds
                }
            };
            await runtime.upsert(
                'client-state:idempotent',
                entry.key,
                JSON.stringify(malformed),
                Number.MAX_SAFE_INTEGER
            );

            await expect(
                repository.findIdempotentClientMutationReceipt(
                    principalRef('alice'),
                    malformedNoOpRequest.requestId
                ),
                variant
            ).rejects.toBeInstanceOf(ClientStateRepositoryInvariantCorruptionError);
            await expect(
                service.upsertPrincipal(SCOPE, 'alice', malformedNoOpRequest),
                `replay ${variant}`
            ).rejects.toBeInstanceOf(ClientStateRepositoryInvariantCorruptionError);
        }
    });

    it('rejects malformed read entries and computed authoritative candidates', () => {
        const command = validPrincipalCommand();
        expect(() =>
            validateUntrustedClientMutationComputeInput({
                command,
                read: []
            })
        ).toThrow(ClientMutationRejectedError);

        const invalidRead = {
            authoritySession: validAuthoritySession(),
            idempotency: null,
            principal: {
                entry: {
                    key: 'principal',
                    value: '{}',
                    expireAtTimestamp: 1_000,
                    updatedTimestamp: 'now',
                    revision: -1
                },
                value: {
                    ...validPrincipalValue(),
                    snapshotVersion: Number.POSITIVE_INFINITY
                }
            },
            instance: null,
            session: null,
            expiredSessionEntry: null,
            snapshot: null,
            receiptEvent: null
        };
        expect(() => validateUntrustedClientMutationComputeInput({ command, read: invalidRead })).toThrow(ClientMutationRejectedError);

        const read: ClientMutationRead = {
            authoritySession: validAuthoritySession(),
            idempotency: null,
            principal: null,
            instance: null,
            session: null,
            expiredSessionEntry: null,
            snapshot: null,
            receiptEvent: null
        };
        const computed = computeClientMutation({ command, read });
        if (!('receipt' in computed)) {
            throw new Error('Expected principal command to compute a receipt');
        }
        const invalidComputed = {
            ...computed,
            receipt: { ...computed.receipt, snapshotVersion: -1 }
        };
        expect(() =>
            validateClientMutation({
                command,
                read,
                computed: invalidComputed
            })
        ).toThrow(ClientMutationRejectedError);
    });
});

class DuplicatingClientInstanceRepository extends AggregateBarrierRepository {
    override async readRuntimeStateBatch(
        selectors: readonly RuntimeStateReadBatchSelector[]
    ): Promise<readonly RuntimeStateReadBatchSelection[]> {
        const selections = await super.readRuntimeStateBatch(selectors);
        return selections.map((selection, index) => {
            const selector = selectors[index];
            return selector?.kind === 'prefix' && selector.namespace === 'client-state:instances'
                ? { ...selection, entries: [...selection.entries, ...selection.entries] }
                : selection;
        });
    }
}

const malformedNoOpRequest = {
    username: 'alice',
    displayName: 'Alice',
    requestId: 'malformed-no-op-replay'
} as const;
const malformedNoOpVariants = [
    'missing-revision',
    'divergent-revision',
    'unexpected-outbox'
] as const;

async function removePersistedWorkspaceId(
    runtime: AggregateBarrierRepository,
    namespace: 'client-state:principals' | 'client-state:instances' | 'client-state:sessions'
): Promise<void> {
    const [entry] = await runtime.findAllEntries(namespace);
    if (!entry) {
        throw new Error(`Expected a stored client-state ${namespace} entry`);
    }
    const persisted = decodeJsonWireValue(JSON.parse(entry.value), `Stored client-state ${namespace} entry`);
    if (!isJsonWireObject(persisted)) {
        throw new TypeError(`Expected stored client-state ${namespace} entry to be an object`);
    }
    const { workspaceId: ignoredWorkspaceId, ...persistedWithoutWorkspaceId } = persisted;
    void ignoredWorkspaceId;
    await runtime.upsert(
        namespace,
        entry.key,
        JSON.stringify(persistedWithoutWorkspaceId),
        Number.MAX_SAFE_INTEGER
    );
}

function validateUntrustedClientMutationComputeInput(input: unknown): void {
    Reflect.apply(computeClientMutation, undefined, [input]);
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
