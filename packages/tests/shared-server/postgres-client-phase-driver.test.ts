import { InMemoryClientStateEventStore } from '@shared-server/rallar-system/state-events/state-event-store.ts';
import type { RuntimeStateEntry } from '@shared-server/runtime-state/runtime-state-repository.ts';
import { describe, expect, it } from 'vitest';
import { createPostgresClientPhaseDriver } from './client-state/postgres-client-mutation-test-driver.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

describe('Postgres client phase driver', () => {
    it('runs mutation reads through the supplied barrier-capable repository', async () => {
        const atEpochMs = Date.now();
        const runtimeRepository = new PhaseRecordingBarrierRepository();
        const driver = createPostgresClientPhaseDriver({
            sql: null as never,
            runtimeRepository,
            atEpochMs,
            serviceId: 'postgres-client-phase-driver-unit',
            createClientStateEventStore: () => new InMemoryClientStateEventStore(),
            writeComputed: () => Promise.resolve()
        });

        await driver.connectSession(
            { applicationId: 'app-1', workspaceId: 'workspace-1' },
            'alice',
            'browser-1',
            'session-1',
            {
                generationId: 'generation-1',
                connectedAtEpochMs: atEpochMs,
                expiresAtEpochMs: atEpochMs + 60_000,
                actorPrincipalId: 'alice',
                actorSessionId: 'session-1',
                requestId: 'phase-driver-read'
            }
        );

        expect(runtimeRepository.phaseOperations).toContain('client-state:principals');
    });
});

class PhaseRecordingBarrierRepository extends FakeRuntimeStateRepository {
    readonly phaseOperations: string[] = [];

    override async findEntry(
        namespace: string,
        key: string
    ): Promise<RuntimeStateEntry | undefined> {
        this.phaseOperations.push(namespace);
        return await super.findEntry(namespace, key);
    }
}
