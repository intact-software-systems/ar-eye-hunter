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
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import type {
    RuntimeStateConditionalWriteResult,
    RuntimeStateEntry,
    RuntimeStateOptimisticTransactionalRepositoryLike
} from '@shared-server/runtime-state/runtime-state-repository.ts';
import { createTestClientStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import type { ClientPrincipalRef, ClientSession } from '@shared/api/client-types.ts';
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

describe('client mutation transaction convergence', () => {
    it('commits a deterministic outbox intent without direct publication and survives a stop before drain', async () => {
        const runtime = new AggregateBarrierRepository();
        const service = createService(runtime, 1_000);
        const written = await service.upsertPrincipal(SCOPE, 'alice', {
            username: 'alice',
            requestId: 'stop-after-commit'
        });

        expect(written.result?.event?.eventType).toBe('principal-created');
        const persisted = await outboxFor(runtime, ['stop-after-commit']);
        expect(persisted).toHaveLength(2);
        expect(persisted.every((entry) => entry.typeId === 'WS_OUTBOX')).toBe(true);
    });

    it('rolls back client state, receipt, event, and outbox when the insert-only outbox collides', async () => {
        const runtime = new AggregateBarrierRepository();
        const repository = createTestClientStateRepository(runtime);
        const timing: RallarTimingEvent[] = [];
        failNextClientStateTestOutboxWrite(runtime);

        await expect(
            createService(runtime, 1_000, (event) => timing.push(event)).upsertPrincipal(SCOPE, 'alice', {
                username: 'alice',
                displayName: 'Should roll back',
                requestId: 'client-outbox-collision'
            })
        ).rejects.toMatchObject({
            code: 'resource-inbox-invariant-corruption'
        });

        expect(await repository.findPrincipal(principalRef('alice'))).toBeUndefined();
        expect(
            await repository.findIdempotentClientMutationReceipt(
                principalRef('alice'),
                'client-outbox-collision'
            )
        ).toBeUndefined();
        expect(await repository.listEvents(principalRef('alice'))).toEqual([]);
        expect(await outboxFor(runtime, ['client-outbox-collision'])).toEqual([]);
        expect(timing).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ operation: 'mutation.write', status: 'error' })
            ])
        );
        expect(timing.map((event) => event.operation)).not.toContain('mutation.conflict');
        expect(timing.filter((event) => event.operation === 'mutation.read')).toHaveLength(1);
    });

    it('returns each client conflict to an explicit outer attempt and keeps it atomic', async () => {
        const runtime = new AlwaysConflictingPrincipalRepository();
        const timing: RallarTimingEvent[] = [];
        const service = createClientStateService({
            runtimeRepository: runtime,
            now: () => 1_000,
            serviceId: 'client-service',
            timing: (event) => timing.push(event)
        });

        for (let attempt = 1; attempt <= 8; attempt += 1) {
            const error = await service
                .upsertInstance(SCOPE, 'alice', 'browser', {
                    platform: 'web',
                    requestId: 'three-conflicts'
                })
                .catch((caught) => caught);

            expect(error).toBeInstanceOf(RuntimeStateWriteConflictError);
            expect(runtime.principalGuardCount).toBe(attempt);
            expect(runtime.transactionBeginCount).toBe(attempt);
        }

        expect(runtime.principalGuardCount).toBe(8);
        expect(runtime.transactionBeginCount).toBe(8);
        expect([...runtime.data.keys()].filter((key) => key.startsWith('client-state:'))).toEqual([]);
        expect(timing.filter((event) => event.operation === 'mutation.write')).toHaveLength(8);
        expect(
            timing
                .filter((event) => event.operation === 'mutation.compute')
                .map((event) => event.details?.attempt)
        ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        expect(timing.map((event) => event.operation)).not.toContain('mutation.conflict');
    });

    it('skips writes for replay, persists semantic no-op receipts, and guards principal first', async () => {
        const runtime = new StatementRecordingRepository();
        const timing: RallarTimingEvent[] = [];
        const service = createClientStateService({
            runtimeRepository: runtime,
            now: () => 1_000,
            serviceId: 'client-service',
            timing: (event) => timing.push(event)
        });
        await service.upsertPrincipal(SCOPE, 'alice', {
            username: 'alice',
            displayName: 'Alice',
            requestId: 'guard-first'
        });
        expect(runtime.transactionStatements[0]).toBe('insertIfAbsent:client-state:principals');
        expect(timing.map((event) => event.operation)).toEqual(
            expect.arrayContaining([
                'mutation.read',
                'mutation.compute',
                'mutation.validate',
                'mutation.write'
            ])
        );

        runtime.resetInstrumentation();
        timing.length = 0;
        await service.upsertPrincipal(SCOPE, 'alice', {
            username: 'alice',
            displayName: 'Alice',
            requestId: 'guard-first'
        });
        expect(runtime.transactionBeginCount).toBe(0);
        expect(runtime.transactionStatements).toEqual([]);
        expect(timing.map((event) => event.operation)).toEqual(
            expect.arrayContaining(['mutation.read', 'mutation.compute', 'mutation.validate'])
        );
        expect(timing.map((event) => event.operation)).not.toContain('mutation.write');

        timing.length = 0;
        await service.upsertPrincipal(SCOPE, 'alice', {
            username: 'alice',
            displayName: 'Alice',
            requestId: 'semantic-no-op'
        });
        expect(runtime.transactionBeginCount).toBe(1);
        expect(runtime.transactionStatements).toEqual(['insertIfAbsent:client-state:idempotent']);
        expect(timing.map((event) => event.operation)).toContain('mutation.write');
    });
});
