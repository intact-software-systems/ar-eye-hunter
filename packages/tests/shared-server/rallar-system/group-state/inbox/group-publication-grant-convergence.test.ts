import { GroupMutationIdempotencyConflictError } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { readGroupStateAuthorityBatch } from '@shared-server/rallar-system/group-state/persistence/read-group-state-authority.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { describe, expect, it } from 'vitest';

import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';
import { groupRef, SCOPE } from '../mutation/group-mutation-test-runtime.ts';
import {
    applyPublicationMutation,
    GRANT_ROOM,
    readGrantRow,
    seedGrantRoom,
    type PublicationDescriptorInput
} from '../mutation/group-publication-grant-test-runtime.ts';
import { createService } from '../presence/group-presence-test-runtime.ts';

const BOB_PUBLISH: PublicationDescriptorInput = {
    operation: 'grantGroupPublication',
    actorPrincipalId: 'alice',
    targetPrincipalId: 'bob',
    topicId: 'room.feed',
    publish: true,
    subscribe: false,
    requestId: 'grant-bob-feed-publish'
};

async function seededRoom(): Promise<GroupBarrierRepository> {
    const runtime = new GroupBarrierRepository();
    await seedGrantRoom(runtime);
    return runtime;
}

async function listGrantEvents(runtime: GroupBarrierRepository) {
    const events = await createTestGroupStateRepository(runtime).listEvents(groupRef(GRANT_ROOM));
    return events.filter((event) => event.eventType === 'publication-grant-changed');
}

describe('group publication grant convergence', () => {
    it('a CAS conflict injected at the guard retries on a fresh read and converges', async () => {
        const runtime = await seededRoom();
        runtime.failNextGroupCas(1);

        await expect(applyPublicationMutation(runtime, BOB_PUBLISH)).rejects.toBeInstanceOf(
            RuntimeStateWriteConflictError
        );
        expect(await readGrantRow(runtime, 'bob')).toBeUndefined();
        await applyPublicationMutation(runtime, BOB_PUBLISH, 2);

        expect((await readGrantRow(runtime, 'bob'))?.topics).toEqual({ 'room.feed': { publish: true, subscribe: false } });
        expect(await listGrantEvents(runtime)).toHaveLength(1);
    });

    it('a grant racing a leave converges to a left member with no grant row', async () => {
        const runtime = await seededRoom();
        const leaveRequest = { status: 'left', actorPrincipalId: 'bob', requestId: 'leave-bob-racing-a-grant' } as const;
        const heldLeave = runtime.holdNextGroupReadFor(groupStateGroupStorageKey(groupRef(GRANT_ROOM)));
        const leave = createService(runtime, 3_000).upsertMember(SCOPE, GRANT_ROOM, 'bob', leaveRequest);
        void leave.catch(() => undefined);
        await heldLeave.firstArrival;

        await applyPublicationMutation(runtime, BOB_PUBLISH);
        heldLeave.release();

        // The leave read no grant row; the grant's snapshotVersion bump makes its group-row CAS miss.
        await expect(leave).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        expect(await readGrantRow(runtime, 'bob')).toBeDefined();
        await createService(runtime, 3_000, 2).upsertMember(SCOPE, GRANT_ROOM, 'bob', leaveRequest);
        const snapshot = await createTestGroupStateRepository(runtime).readSnapshot(groupRef(GRANT_ROOM));
        expect(snapshot?.members.find((member) => member.principalId === 'bob')).toMatchObject({ status: 'left' });
        expect(await readGrantRow(runtime, 'bob')).toBeUndefined();
    });

    it('an idempotent replay returns the first result and a changed body is group-mutation-idempotency-conflict', async () => {
        const runtime = await seededRoom();
        const first = await applyPublicationMutation(runtime, BOB_PUBLISH);
        const replay = await applyPublicationMutation(runtime, BOB_PUBLISH);

        expect(replay.result?.event?.eventId).toBe(first.result?.event?.eventId);
        expect(await listGrantEvents(runtime)).toHaveLength(1);
        await expect(applyPublicationMutation(runtime, { ...BOB_PUBLISH, subscribe: true })).rejects.toMatchObject({
            code: 'group-mutation-idempotency-conflict'
        });
        await expect(applyPublicationMutation(runtime, { ...BOB_PUBLISH, subscribe: true })).rejects.toBeInstanceOf(
            GroupMutationIdempotencyConflictError
        );
    });

    it('persisted readback through the authority read returns the written row', async () => {
        const runtime = await seededRoom();
        await applyPublicationMutation(runtime, BOB_PUBLISH);

        const batch = await readGroupStateAuthorityBatch(runtime, groupRef(GRANT_ROOM), 3_000);
        expect(batch.publicationGrants.map((grant) => grant.value)).toEqual([
            {
                ...groupRef(GRANT_ROOM),
                principalId: 'bob',
                topics: { 'room.feed': { publish: true, subscribe: false } },
                updated: expect.objectContaining({ actor: expect.objectContaining({ principalId: 'alice' }) })
            }
        ]);
    });
});
