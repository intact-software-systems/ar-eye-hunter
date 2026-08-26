import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { describe, expect, it } from 'vitest';

import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { groupStatePresenceAdmissionStorageKey } from '@shared-server/rallar-system/group-state/persistence/presence/group-presence-storage-keys.ts';
import { createTestGroupStateService } from '../group-state-test-runtime.ts';
import { ApplyingGuardedBatchRepository, OrderedGroupEventStore } from './group-mutation-test-runtime.ts';

const SCOPE = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1'
} as const;
const BASE_EPOCH_MS = 1_900_000_000_000;

describe('GroupStateService guarded batch convergence', () => {
    it('converges independent group services after a concurrent batch re-read', async () => {
        const runtime = new ApplyingGuardedBatchRepository();
        runtime.serializeTransactions = true;
        const eventStore = new OrderedGroupEventStore(runtime);
        const seed = createService({
            runtime,
            eventStore,
            nowEpochMs: BASE_EPOCH_MS,
            sleep: () => Promise.resolve(),
            instanceId: 'seed'
        });
        const groupId = 'independent-group-convergence';
        await seed.createGroup(SCOPE, {
            groupId,
            displayName: 'Independent group convergence',
            kind: 'room',
            joinMode: 'open',
            createdByPrincipalId: 'alice',
            requestId: 'independent-group-seed'
        });
        runtime.resetObservations();
        const sleep = async () => {
            expect(runtime.activeTransactionDepth).toBe(0);
        };
        const first = createService({
            runtime,
            eventStore,
            nowEpochMs: BASE_EPOCH_MS + 1_000,
            sleep,
            instanceId: 'first'
        });
        const second = createService({
            runtime,
            eventStore,
            nowEpochMs: BASE_EPOCH_MS + 1_001,
            sleep,
            instanceId: 'second'
        });
        runtime.blockMatchingBatchReads(
            'group-state:groups',
            groupStateGroupStorageKey({ ...SCOPE, groupId }),
            2
        );

        const results = await Promise.all([
            first.updateGroup(SCOPE, groupId, {
                displayName: 'Independent first',
                actorPrincipalId: 'alice',
                requestId: 'independent-group-first'
            }),
            second.updateGroup(SCOPE, groupId, {
                description: 'Independent second',
                actorPrincipalId: 'alice',
                requestId: 'independent-group-second'
            })
        ]);

        const repository = createTestGroupStateRepository(runtime, eventStore);
        const snapshot = await repository.readSnapshot({ ...SCOPE, groupId });
        const receipts = await Promise.all([
            repository.findIdempotentGroupMutationReceipt(
                { ...SCOPE, groupId },
                'independent-group-first'
            ),
            repository.findIdempotentGroupMutationReceipt(
                { ...SCOPE, groupId },
                'independent-group-second'
            )
        ]);
        expect(results.every(({ status }) => status === 'ok')).toBe(true);
        expect(receipts.map((stored) => stored?.receipt.attemptCount).sort()).toEqual([1, 2]);
        expect(snapshot?.group.snapshotVersion).toBe(3);
        expect(snapshot?.group.displayName).toBe('Independent first');
        expect(snapshot?.group.description).toBe('Independent second');
        expect(eventStore.events).toHaveLength(3);
    });

    it('converges independent presence services on one admission slot', async () => {
        const runtime = new ApplyingGuardedBatchRepository();
        runtime.serializeTransactions = true;
        const eventStore = new OrderedGroupEventStore(runtime);
        const groupId = 'independent-presence-convergence';
        const seed = createService({
            runtime,
            eventStore,
            nowEpochMs: BASE_EPOCH_MS,
            sleep: () => Promise.resolve(),
            instanceId: 'seed'
        });
        await seed.createGroup(SCOPE, {
            groupId,
            displayName: 'Independent presence convergence',
            kind: 'room',
            joinMode: 'open',
            maxSessionsPerMember: 1,
            createdByPrincipalId: 'alice',
            requestId: 'independent-presence-seed'
        });
        runtime.resetObservations();
        const sleepDelays: number[] = [];
        const sleep = async (delayMs: number) => {
            expect(runtime.activeTransactionDepth).toBe(0);
            sleepDelays.push(delayMs);
        };
        const first = createService({
            runtime,
            eventStore,
            nowEpochMs: BASE_EPOCH_MS + 1_000,
            sleep,
            instanceId: 'first'
        });
        const second = createService({
            runtime,
            eventStore,
            nowEpochMs: BASE_EPOCH_MS + 1_001,
            sleep,
            instanceId: 'second'
        });
        const ref = { ...SCOPE, groupId };
        runtime.blockMatchingBatchReads(
            'group-state:presence-admissions',
            groupStatePresenceAdmissionStorageKey({
                ...ref,
                principalId: 'alice'
            }),
            2
        );

        const results = await Promise.allSettled([
            first.connectPresenceSession(SCOPE, groupId, 'session-a', {
                principalId: 'alice',
                generationId: 'generation-a',
                expiresAtEpochMs: BASE_EPOCH_MS + 60_000,
                requestId: 'independent-presence-a'
            }),
            second.connectPresenceSession(SCOPE, groupId, 'session-b', {
                principalId: 'alice',
                generationId: 'generation-b',
                expiresAtEpochMs: BASE_EPOCH_MS + 60_000,
                requestId: 'independent-presence-b'
            })
        ]);

        const repository = createTestGroupStateRepository(runtime, eventStore);
        const admission = await repository.findPresenceAdmissionEntry({
            ...ref,
            principalId: 'alice'
        });
        const sessions = await repository.listPresenceSessions(ref);
        const accepted = results.filter(
            (result) => result.status === 'fulfilled' && result.value.status === 'ok'
        );
        expect(accepted).toHaveLength(1);
        expect(runtime.batches).toHaveLength(2);
        expect(sleepDelays).toEqual([2]);
        expect(admission?.value.admittedSessions).toHaveLength(1);
        expect(sessions).toHaveLength(1);
        expect(eventStore.events).toHaveLength(2);
    });
});

interface ConvergenceServiceInput {
    readonly runtime: ApplyingGuardedBatchRepository;
    readonly eventStore: OrderedGroupEventStore;
    readonly nowEpochMs: number;
    readonly sleep: (delayMs: number) => Promise<void>;
    readonly instanceId: string;
}

function createService({
    runtime,
    eventStore,
    nowEpochMs,
    sleep,
    instanceId
}: ConvergenceServiceInput) {
    let generatedId = 0;
    return createTestGroupStateService({
        runtimeRepository: runtime,
        groupStateEventStoreFor: () => eventStore,
        now: () => nowEpochMs,
        randomId: () => `${instanceId}-id-${++generatedId}`,
        sleep,
        serviceId: `${instanceId}-group-service`
    });
}
