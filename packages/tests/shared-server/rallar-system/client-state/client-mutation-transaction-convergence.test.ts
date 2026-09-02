import { describe, expect, it } from 'vitest';

import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { createTestClientStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';

import {
    AggregateBarrierRepository,
    AlwaysConflictingPrincipalRepository,
    createService,
    outboxFor,
    StatementRecordingRepository
} from './client-mutation-concurrency-test-runtime.ts';
import { CLIENT_MUTATION_TEST_SCOPE, clientMutationPrincipalRef } from './client-mutation-validation-test-fixtures.ts';
import { createClientStateTestDriver, failNextClientStateTestOutboxWrite } from './client-state-test-runtime.ts';

describe('client mutation transaction convergence', () => {
    it('commits a deterministic outbox intent without direct publication and survives a stop before drain', async () => {
        const runtime = new AggregateBarrierRepository();
        const service = createService(runtime, 1_000);
        const written = await service.upsertPrincipal(CLIENT_MUTATION_TEST_SCOPE, 'alice', {
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
            createService(runtime, 1_000, (event) => timing.push(event)).upsertPrincipal(CLIENT_MUTATION_TEST_SCOPE, 'alice', {
                username: 'alice',
                displayName: 'Should roll back',
                requestId: 'client-outbox-collision'
            })
        ).rejects.toMatchObject({
            code: 'resource-inbox-invariant-corruption'
        });

        expect(await repository.findPrincipal(clientMutationPrincipalRef('alice'))).toBeUndefined();
        expect(
            await repository.findIdempotentClientMutationReceipt(
                clientMutationPrincipalRef('alice'),
                'client-outbox-collision'
            )
        ).toBeUndefined();
        expect(await repository.listEvents(clientMutationPrincipalRef('alice'))).toEqual([]);
        expect(await outboxFor(runtime, ['client-outbox-collision'])).toEqual([]);
        expect(timing).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ operation: 'mutation.write', status: 'error' })
            ])
        );
        expect(timing.map((event) => event.operation)).not.toContain('mutation.conflict');
        expect(timing.filter((event) => event.operation === 'mutation.read')).toHaveLength(1);
    });

    it('exhausts conflicting client writes and keeps failed attempts atomic', async () => {
        const runtime = new AlwaysConflictingPrincipalRepository();
        const timing: RallarTimingEvent[] = [];
        const service = createClientStateTestDriver({
            runtimeRepository: runtime,
            now: () => 1_000,
            serviceId: 'client-service',
            timing: (event) => timing.push(event)
        });

        const error = await service
            .upsertInstance(CLIENT_MUTATION_TEST_SCOPE, 'alice', 'browser', {
                platform: 'web',
                requestId: 'three-conflicts'
            })
            .catch((caught) => caught);

        expect(error).toBeInstanceOf(RuntimeStateWriteConflictError);
        expect(runtime.principalGuardCount).toBe(8);
        expect(runtime.transactionBeginCount).toBe(8);
        expect([...runtime.data.keys()].filter((key) => key.startsWith('client-state:'))).toEqual([]);
        expect(timing.filter((event) => event.operation === 'mutation.write')).toHaveLength(8);
        expect(timing.map((event) => event.operation)).not.toContain('mutation.conflict');
    });

    it('skips writes for replay, persists semantic no-op receipts, and guards principal first', async () => {
        const runtime = new StatementRecordingRepository();
        const timing: RallarTimingEvent[] = [];
        const service = createClientStateTestDriver({
            runtimeRepository: runtime,
            now: () => 1_000,
            serviceId: 'client-service',
            timing: (event) => timing.push(event)
        });
        await service.upsertPrincipal(CLIENT_MUTATION_TEST_SCOPE, 'alice', {
            username: 'alice',
            displayName: 'Alice',
            requestId: 'guard-first'
        });
        expect(runtime.transactionStatements[0]).toBe('insertIfAbsent:client-state:principals');
        expect(timing.map((event) => event.operation)).toEqual(
            expect.arrayContaining([
                'mutation.read',
                'mutation.write'
            ])
        );

        runtime.resetInstrumentation();
        timing.length = 0;
        await service.upsertPrincipal(CLIENT_MUTATION_TEST_SCOPE, 'alice', {
            username: 'alice',
            displayName: 'Alice',
            requestId: 'guard-first'
        });
        expect(runtime.transactionBeginCount).toBe(0);
        expect(runtime.transactionStatements).toEqual([]);
        expect(timing.map((event) => event.operation)).toEqual(
            expect.arrayContaining(['mutation.read'])
        );
        expect(timing.map((event) => event.operation)).not.toContain('mutation.write');

        timing.length = 0;
        await service.upsertPrincipal(CLIENT_MUTATION_TEST_SCOPE, 'alice', {
            username: 'alice',
            displayName: 'Alice',
            requestId: 'semantic-no-op'
        });
        expect(runtime.transactionBeginCount).toBe(1);
        expect(runtime.transactionStatements).toEqual(['insertIfAbsent:client-state:idempotent']);
        expect(timing.map((event) => event.operation)).toContain('mutation.write');
    });
});
