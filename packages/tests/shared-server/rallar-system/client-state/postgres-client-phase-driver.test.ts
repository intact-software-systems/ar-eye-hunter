import type { ClientMutationComputedWrite } from '@shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts';
import { InMemoryClientStateEventStore } from '@shared-server/rallar-system/state-events/in-memory-client-state-event-store.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import type { RuntimeStateEntry } from '@shared-server/runtime-state/runtime-state-repository.ts';
import { describe, expect, it } from 'vitest';
import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createPostgresClientPhaseDriver } from './postgres-client-mutation-test-driver.ts';

describe('Postgres client phase driver', () => {
    it('runs mutation reads through the supplied barrier-capable repository', async () => {
        const atEpochMs = Date.now();
        const runtimeRepository = new PhaseRecordingBarrierRepository();
        const driver = createPostgresClientPhaseDriver({
            sql: null as never,
            runtimeRepository,
            atEpochMs,
            serviceId: 'postgres-client-phase-driver-unit',
            clientStateEventStore: new InMemoryClientStateEventStore(),
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

    it('returns conflicts to distinct outer attempts with preserved attempt facts', async () => {
        const atEpochMs = Date.now();
        const attempts: number[] = [];
        const driver = createPostgresClientPhaseDriver({
            sql: null as never,
            runtimeRepository: new FakeRuntimeStateRepository(),
            atEpochMs,
            serviceId: 'postgres-client-phase-driver-unit',
            clientStateEventStore: new InMemoryClientStateEventStore(),
            writeComputed: (computed) => recordPostgresAttempt(computed, attempts)
        });
        const request = {
            generationId: 'generation-1',
            connectedAtEpochMs: atEpochMs,
            expiresAtEpochMs: atEpochMs + 60_000,
            actorPrincipalId: 'alice',
            actorSessionId: 'session-1',
            requestId: 'phase-driver-conflict'
        } as const;

        await expect(
            driver.connectSession(
                { applicationId: 'app-1', workspaceId: 'workspace-1' },
                'alice',
                'browser-1',
                'session-1',
                request
            )
        ).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        expect(attempts).toEqual([1]);

        await expect(
            driver.connectSession(
                { applicationId: 'app-1', workspaceId: 'workspace-1' },
                'alice',
                'browser-1',
                'session-1',
                request
            )
        ).resolves.toMatchObject({ outcome: 'write' });
        expect(attempts).toEqual([1, 2]);
    });
});

function recordPostgresAttempt(
    computed: ClientMutationComputedWrite,
    attempts: number[]
): Promise<void> {
    attempts.push(computed.receipt.attemptCount);
    return attempts.length === 1
        ? Promise.reject(new RuntimeStateWriteConflictError())
        : Promise.resolve();
}

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
