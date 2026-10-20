import { describe, expect, it } from 'vitest';

import { createClientStateService } from '@shared-server/rallar-system/client-state/client-state-service.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { InMemoryClientStateEventStore } from '@shared-server/rallar-system/state-events/in-memory-client-state-event-store.ts';
import type {
    RuntimeStateReadBatchSelection,
    RuntimeStateReadBatchSelector
} from '@shared-server/runtime-state/read-batch/runtime-state-read-batch.ts';

import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { principalCommand } from './client-mutation-compute-test-fixtures.ts';

class HeldAudienceRepository extends FakeRuntimeStateRepository {
    readonly audienceStarted = Promise.withResolvers<void>();
    readonly audienceResult = Promise.withResolvers<void>();

    override async readRuntimeStateBatch(
        selectors: readonly RuntimeStateReadBatchSelector[]
    ): Promise<readonly RuntimeStateReadBatchSelection[]> {
        if (selectors.some((selector) => selector.kind === 'prefix-suffix')) {
            this.audienceStarted.resolve();
            await this.audienceResult.promise;
        }
        return await super.readRuntimeStateBatch(selectors);
    }
}

describe('client mutation read timing', () => {
    it('distinguishes completed own-state reads from an audience read still in flight', async () => {
        const runtimeRepository = new HeldAudienceRepository();
        const events: RallarTimingEvent[] = [];
        const service = createClientStateService({
            runtimeRepository,
            clientStateEventStore: new InMemoryClientStateEventStore(),
            serviceId: 'read-timing',
            timing: (event) => events.push(event)
        });
        const reading = service.read(principalCommand('observed-read'));
        await runtimeRepository.audienceStarted.promise;
        const beforeRelease = events.map((event) => event.operation);
        runtimeRepository.audienceResult.resolve();
        const result = await reading;

        expect(beforeRelease).toEqual(['mutation.read-state', 'mutation.read-receipt']);
        expect(events.map((event) => [event.operation, event.status])).toEqual([
            ['mutation.read-state', 'ok'],
            ['mutation.read-receipt', 'ok'],
            ['mutation.read-audience-groups', 'ok'],
            ['mutation.read-audience-clients', 'ok'],
            ['mutation.read', 'ok']
        ]);
        expect(events.every((event) =>
            event.requestId === 'observed-read' &&
            event.principalId === 'alice' && event.serviceId === 'read-timing' &&
            Number.isFinite(event.durationMs) && event.durationMs >= 0
        )).toBe(true);
        expect(result.audienceGroupSnapshots).toEqual([]);
        expect(result.audienceCoMemberSessions).toEqual([]);
    });

    it('records the failed audience boundary and preserves the original failure', async () => {
        const runtimeRepository = new HeldAudienceRepository();
        const events: RallarTimingEvent[] = [];
        const service = createClientStateService({
            runtimeRepository,
            clientStateEventStore: new InMemoryClientStateEventStore(),
            serviceId: 'read-timing',
            timing: (event) => events.push(event)
        });
        const failure = new Error('audience repository failed');
        const reading = service.read(principalCommand());
        const rejection = expect(reading).rejects.toBe(failure);
        await runtimeRepository.audienceStarted.promise;
        runtimeRepository.audienceResult.reject(failure);
        await rejection;

        expect(events.map((event) => [event.operation, event.status])).toEqual([
            ['mutation.read-state', 'ok'],
            ['mutation.read-receipt', 'ok'],
            ['mutation.read-audience-groups', 'error'],
            ['mutation.read', 'error']
        ]);
    });

    it.each(['disabled', 'throwing'] as const)('preserves read results with %s timing', async (mode) => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const input = {
            runtimeRepository,
            clientStateEventStore: new InMemoryClientStateEventStore(),
            serviceId: 'read-timing',
            nowMs: () => 1_000
        };
        const baseline = await createClientStateService(input).read(principalCommand());
        const service = createClientStateService({
            ...input,
            timing: mode === 'disabled' ? undefined : () => {
                throw new Error('timing sink failed');
            }
        });

        await expect(service.read(principalCommand())).resolves.toEqual(baseline);
    });
});
