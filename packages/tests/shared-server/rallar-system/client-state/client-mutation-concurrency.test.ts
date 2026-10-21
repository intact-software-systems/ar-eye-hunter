import { createTestClientStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import {
    describe,
    expect,
    it
} from 'vitest';

import { createClientStateService } from '@shared-server/rallar-system/client-state/client-state-service.ts';
import { toClientMutationSystemAuthority } from '@shared-server/rallar-system/client-state/mutation/client-mutation-authority.ts';
import { toClientMutationCommand } from '@shared-server/rallar-system/client-state/mutation/client-mutation-command.ts';
import { toExpireClientSessionMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-expire-client-session-mutation-input.ts';
import { computeClientMutation } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts';
import { clientStatePrincipalStorageKey } from '@shared-server/rallar-system/client-state/persistence/client-state-principal-storage-key.ts';
import {
    CLIENT_STATE_INSTANCES_NAMESPACE,
    CLIENT_STATE_PRINCIPALS_NAMESPACE,
    CLIENT_STATE_SESSIONS_NAMESPACE
} from '@shared-server/rallar-system/client-state/persistence/client-state-runtime-namespaces.ts';
import { toClientSessionExpiryCandidate } from '@shared-server/rallar-system/presence/session-expiry.ts';
import { InMemoryClientStateEventStore } from '@shared-server/rallar-system/state-events/in-memory-client-state-event-store.ts';
import type {
    RuntimeStateReadBatchSelection,
    RuntimeStateReadBatchSelector
} from '@shared-server/runtime-state/read-batch/runtime-state-read-batch.ts';
import type { RuntimeStateEntry } from '@shared-server/runtime-state/runtime-state-repository.ts';
import { assertClientMutationMatchesRecompute } from '@shared-test/shared-server/assert-client-mutation-matches-recompute.ts';

import { emptyRead, principalCommand } from './client-mutation-compute-test-fixtures.ts';
import {
    CLIENT_MUTATION_BASE_EPOCH_MS,
    connect,
    PrincipalChangeAfterFirstReadRepository
} from './client-mutation-concurrency-test-runtime.ts';
import { clientMutationPrincipalRef } from './client-mutation-validation-test-fixtures.ts';
import { TEST_DISCONNECTED_SESSION_RETENTION_MS } from './test-disconnected-session-retention.ts';

describe('client mutation pure retry compute', () => {
    it('is deterministic and does not mutate a frozen command or read', () => {
        const command = deepFreeze(principalCommand());
        const read = deepFreeze(emptyRead(command));

        const first = computeClientMutation({ command, read });
        const second = computeClientMutation({ command, read });
        assertClientMutationMatchesRecompute({ command, read, computed: first });
        assertClientMutationMatchesRecompute({ command, read, computed: second });

        expect(second).toEqual(first);
        expect(command).toEqual(structuredClone(command));
        expect(read).toEqual(structuredClone(read));
    });
});

function deepFreeze<T>(value: T): T {
    if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
        return value;
    }
    Object.freeze(value);
    for (const child of Object.values(value)) {
        deepFreeze(child);
    }
    return value;
}

describe('client mutation stable-read concurrency', () => {
    it('reads the principal guard and its children in one batch statement, never in separate reads', async () => {
        const runtime = new PrincipalReadRecordingRepository();
        await connect({ runtime, sessionId: 'session-a', generationId: 'generation-a', nowEpochMs: CLIENT_MUTATION_BASE_EPOCH_MS });
        const repository = createTestClientStateRepository(runtime);
        const session = await repository.findSession({
            ...clientMutationPrincipalRef('alice'),
            clientInstanceId: 'browser',
            sessionId: 'session-a'
        });
        if (!session) {
            throw new Error('Expected a stored client session');
        }
        const command = toClientMutationCommand(
            toExpireClientSessionMutationInput(toClientSessionExpiryCandidate(session)),
            {
                nowEpochMs: session.expiresAtEpochMs,
                serviceId: 'client-service',
                eventId: 'stable-client-read-event',
                attemptCount: 1,
                expireAtEpochMs: session.expiresAtEpochMs + 60_000,
                disconnectedSessionRetentionMs: TEST_DISCONNECTED_SESSION_RETENTION_MS
            },
            toClientMutationSystemAuthority('client-service')
        );
        runtime.armPrincipalChangeAfterRead();
        runtime.clearRecordedReads();

        const read = await createClientStateService({
            runtimeRepository: runtime,
            clientStateEventStore: new InMemoryClientStateEventStore(),
            serviceId: 'client-service'
        }).read(command);

        const principalKey = clientStatePrincipalStorageKey(clientMutationPrincipalRef('alice'));
        const principalBatches = runtime.batchReads.filter((selectors) => selectors.some(({ namespace }) => namespace === CLIENT_STATE_PRINCIPALS_NAMESPACE));
        expect(principalBatches).toHaveLength(1);
        expect(principalBatches[0]).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'key', namespace: CLIENT_STATE_PRINCIPALS_NAMESPACE, key: principalKey }),
            expect.objectContaining({ kind: 'prefix', namespace: CLIENT_STATE_INSTANCES_NAMESPACE, keyPrefix: `${principalKey}:` }),
            expect.objectContaining({ kind: 'prefix', namespace: CLIENT_STATE_SESSIONS_NAMESPACE, keyPrefix: `${principalKey}:` })
        ]));
        expect(runtime.clientStateEntryReads).toEqual([]);
        expect(read.snapshot?.stateRevision).toBe((read.principal?.entry.revision ?? -1) + 1);
        expect(read.snapshot?.principal).toEqual(read.principal?.value);
    });
});

/** Records the batch selectors and the single-row client-state reads a mutation read issues. */
class PrincipalReadRecordingRepository extends PrincipalChangeAfterFirstReadRepository {
    readonly batchReads: (readonly RuntimeStateReadBatchSelector[])[] = [];
    readonly clientStateEntryReads: string[] = [];

    clearRecordedReads(): void {
        this.batchReads.length = 0;
        this.clientStateEntryReads.length = 0;
    }

    override async readRuntimeStateBatch(
        selectors: readonly RuntimeStateReadBatchSelector[]
    ): Promise<readonly RuntimeStateReadBatchSelection[]> {
        this.batchReads.push(selectors);
        return await super.readRuntimeStateBatch(selectors);
    }

    override async findEntry(namespace: string, key: string): Promise<RuntimeStateEntry | undefined> {
        if (namespace.startsWith('client-state:')) {
            this.clientStateEntryReads.push(namespace);
        }
        return await super.findEntry(namespace, key);
    }
}
