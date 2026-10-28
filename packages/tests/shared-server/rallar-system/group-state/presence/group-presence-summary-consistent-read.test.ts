import { describe, expect, it } from 'vitest';

import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { GROUPS_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { GroupPresenceSummaryWork } from '@shared-server/rallar-system/group-state/presence/group-presence-summary-worker.ts';
import type { RuntimeStateReadBatchSelection, RuntimeStateReadBatchSelector } from '@shared-server/runtime-state/read-batch/runtime-state-read-batch.ts';
import type { RuntimeStateEntry } from '@shared-server/runtime-state/runtime-state-repository.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import type { GroupEvent } from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import type { GroupPresenceSummaryWorkData } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';
import { groupRef, SCOPE } from '../mutation/group-mutation-test-runtime.ts';
import { createService, summaryReservationRead } from './group-presence-test-runtime.ts';

const BASE_EPOCH_MS = Date.now();
const GROUP_ID = 'consistent-summary-read';

/**
 * Lands one armed write right after the first stored read of the next summary read returns, and
 * holds every other read until the write is in: the store-level picture of a write committing
 * between the statements of a read that is not one consistent snapshot.
 */
class InterleavingWriteRepository extends GroupBarrierRepository {
    private armedWrite: (() => Promise<void>) | undefined;
    private writeLanded: Promise<void> = Promise.resolve();
    private writing = false;

    armInterleavedWrite(write: () => Promise<void>): void {
        this.armedWrite = write;
    }

    override async findEntry(namespace: string, key: string): Promise<RuntimeStateEntry | undefined> {
        return await this.readThenInterleave(() => super.findEntry(namespace, key));
    }

    override async readRuntimeStateBatch(
        selectors: readonly RuntimeStateReadBatchSelector[]
    ): Promise<readonly RuntimeStateReadBatchSelection[]> {
        return await this.readThenInterleave(() => super.readRuntimeStateBatch(selectors));
    }

    private async readThenInterleave<T>(read: () => Promise<T>): Promise<T> {
        if (this.writing) {
            return await read();
        }
        const write = this.armedWrite;
        if (write === undefined) {
            await this.writeLanded;
            return await read();
        }
        this.armedWrite = undefined;
        let landWrite = (): void => {};
        this.writeLanded = new Promise<void>((resolve) => {
            landWrite = resolve;
        });
        const result = await read();
        this.writing = true;
        try {
            await write();
        }
        finally {
            this.writing = false;
            landWrite();
        }
        return result;
    }
}

describe('the presence summary read (D295)', () => {
    it('reads the group and its roster as one consistent snapshot while a join commits between its reads', async () => {
        const runtime = new InterleavingWriteRepository();
        const command = await seedGroupWithMember(runtime, 'bob');
        const repository = createTestGroupStateRepository(runtime);
        runtime.armInterleavedWrite(async () => {
            const group = await repository.findGroup(groupRef(GROUP_ID));
            const bob = await repository.findMember({ ...groupRef(GROUP_ID), principalId: 'bob' });
            if (!group || !bob) {
                throw new Error('Seeded group and member are required');
            }
            await repository.putMember({ ...bob, principalId: 'carol' });
            await repository.putGroup({ ...group, activeMemberCount: group.activeMemberCount + 1 });
        });

        const read = await createWork(runtime).read(
            [{ traceId: 'trace-group-presence-summary-consistent-read', work: command, reservation: summaryReservationRead(command.commandId) }],
            BASE_EPOCH_MS + 1_000
        );

        const [summaryRead] = read.right ?? [];
        expect(read.left).toBeUndefined();
        expect(summaryRead?.presence.group.value.activeMemberCount).toBe(
            summaryRead?.presence.members.filter(({ value }) => value.status === 'active').length
        );
    });

    it('answers a stored roster that contradicts its group as a typed inconsistent read, not a TypeError', async () => {
        const runtime = new GroupBarrierRepository();
        const command = await seedGroupWithMember(runtime, 'bob');
        const repository = createTestGroupStateRepository(runtime);
        const group = await repository.findGroup(groupRef(GROUP_ID));
        if (!group) {
            throw new Error('Seeded group is required');
        }
        await repository.putGroup({ ...group, activeMemberCount: group.activeMemberCount + 1 });

        const read = await createWork(runtime).read(
            [{ traceId: 'trace-group-presence-summary-consistent-read', work: command, reservation: summaryReservationRead(command.commandId) }],
            BASE_EPOCH_MS + 1_000
        );

        expect(read.right).toBeUndefined();
        expect(read.left).toMatchObject({ code: 'group-presence-summary-roster-inconsistent' });
    });

    it('omits an expired group without removing its physical row', async () => {
        const runtime = new GroupBarrierRepository();
        const command = await seedGroupWithMember(runtime, 'bob');
        const key = groupStateGroupStorageKey(groupRef(GROUP_ID));
        const stored = await runtime.findEntry(GROUPS_NAMESPACE, key);
        if (!stored) {
            throw new Error('Seeded group is required');
        }
        await runtime.upsert(GROUPS_NAMESPACE, key, stored.value, Date.now() - 1);
        const expired = await runtime.findEntry(GROUPS_NAMESPACE, key);

        const read = await createWork(runtime).read(
            [{ traceId: 'trace-group-presence-summary-consistent-read', work: command, reservation: summaryReservationRead(command.commandId) }],
            BASE_EPOCH_MS + 1_000
        );

        expect(read.left).toBeUndefined();
        expect(read.right).toEqual([]);
        expect(await runtime.findEntry(GROUPS_NAMESPACE, key)).toEqual(expired);
    });
});

function createWork(runtime: GroupBarrierRepository): GroupPresenceSummaryWork {
    return new GroupPresenceSummaryWork({
        outboxQueueReader: new OutboxQueueReader(new InMemoryQueueBox()),
        recomputeDebounceMs: 0,
        recomputeMaxWaitMs: 0,
        runtimeRepository: runtime,
        now: () => BASE_EPOCH_MS + 1_000,
        serviceId: 'summary-worker',
        senderPeerId: 'ws-server'
    });
}

async function seedGroupWithMember(
    runtime: GroupBarrierRepository,
    principalId: string
): Promise<GroupPresenceSummaryWorkData> {
    const service = createService(runtime, BASE_EPOCH_MS);
    await service.createGroup(SCOPE, {
        groupId: GROUP_ID,
        displayName: GROUP_ID,
        kind: 'room',
        joinMode: 'open',
        createdByPrincipalId: 'alice',
        requestId: `seed-${GROUP_ID}`
    });
    await service.upsertMember(SCOPE, GROUP_ID, principalId, {
        status: 'active',
        actorPrincipalId: 'alice',
        requestId: `activate-${GROUP_ID}-${principalId}`
    });
    await service.connectPresenceSession(SCOPE, GROUP_ID, `${GROUP_ID}-${principalId}-session`, {
        principalId,
        generationId: `${GROUP_ID}-${principalId}-generation`,
        connectionGenerationId: `${GROUP_ID}-${principalId}-ws-generation`,
        actorPrincipalId: principalId,
        expiresAtEpochMs: BASE_EPOCH_MS + 60_000,
        requestId: `connect-${GROUP_ID}-${principalId}`
    });
    const event = (await createTestGroupStateRepository(runtime).listEvents(groupRef(GROUP_ID))).findLast(
        (candidate: GroupEvent) => candidate.eventType === 'session-connected'
    );
    if (!event) {
        throw new Error('Missing session-connected event');
    }
    return {
        effectKind: 'group-presence-summary',
        aggregateRef: groupRef(GROUP_ID),
        commandId: `${GROUP_ID}-command`,
        createdAtEpochMs: event.occurredAtEpochMs,
        expireAtEpochMs: NEVER_EXPIRE_AT_TIMESTAMP,
        acceptedCausalRevision: event.causalRevision,
        event
    };
}
