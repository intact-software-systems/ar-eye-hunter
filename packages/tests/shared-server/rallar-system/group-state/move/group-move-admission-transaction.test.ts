import { computeGroupMoveAdmission } from '@shared-server/rallar-system/group-state/move/compute-group-move-admission.ts';
import { writeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/write/write-group-mutation.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { createGroupMoveTestDatabase, DESTINATION } from './group-move-test-database.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const close of cleanups.splice(0)) {
        await close();
    }
});

async function database() {
    const fixture = await createGroupMoveTestDatabase();
    cleanups.push(fixture.storage.close);
    return fixture;
}

describe('group move admission transaction', () => {
    it('writes the entire staged roster and its events in one transaction', async () => {
        const fixture = await database();
        const result = computeGroupMoveAdmission({ participants: await Promise.all([fixture.join('bob'), fixture.join('carol')]) });
        if (result.status !== 'admitted') {
            throw new Error('Expected an admitted cohort');
        }

        await fixture.storage.sql.begin(async (transaction) => {
            for (const mutation of result.mutations) {
                await writeGroupMutation(transaction, mutation);
            }
        });

        const snapshot = await fixture.repository.readSnapshot(DESTINATION);
        expect(snapshot?.members.map((member) => member.principalId).sort()).toEqual(['alice', 'bob', 'carol']);
        expect(snapshot?.group.activeMemberCount).toBe(3);
        const events = await fixture.repository.listEvents(DESTINATION);
        expect(events.filter((event) => event.eventType === 'member-joined')).toHaveLength(2);
    });

    it('rolls back every admission and event when a later transaction effect fails', async () => {
        const fixture = await database();
        const before = await fixture.repository.readSnapshot(DESTINATION);
        const eventsBefore = await fixture.repository.listEvents(DESTINATION);
        const result = computeGroupMoveAdmission({ participants: await Promise.all([fixture.join('bob'), fixture.join('carol')]) });
        if (result.status !== 'admitted') {
            throw new Error('Expected an admitted cohort');
        }

        await expect(fixture.storage.sql.begin(async (transaction) => {
            for (const mutation of result.mutations) {
                await writeGroupMutation(transaction, mutation);
            }
            throw new Error('Injected terminal-result write failure');
        })).rejects.toThrow('Injected terminal-result write failure');

        expect(await fixture.repository.readSnapshot(DESTINATION)).toEqual(before);
        expect(await fixture.repository.listEvents(DESTINATION)).toEqual(eventsBefore);
    });

    it('rejects the entire stale cohort after a competing admission consumes a place', async () => {
        const fixture = await database();
        const cohort = computeGroupMoveAdmission({ participants: await Promise.all([fixture.join('bob'), fixture.join('carol')]) });
        const competitor = computeGroupMoveAdmission({ participants: [await fixture.join('dave')] });
        if (cohort.status !== 'admitted' || competitor.status !== 'admitted') {
            throw new Error('Expected both proposals to observe enough space initially');
        }
        await fixture.storage.sql.begin(async (transaction) => {
            for (const mutation of competitor.mutations) {
                await writeGroupMutation(transaction, mutation);
            }
        });

        await expect(fixture.storage.sql.begin(async (transaction) => {
            for (const mutation of cohort.mutations) {
                await writeGroupMutation(transaction, mutation);
            }
        })).rejects.toThrow(RuntimeStateWriteConflictError);

        expect((await fixture.repository.readSnapshot(DESTINATION))?.members.map((member) => member.principalId).sort())
            .toEqual(['alice', 'dave']);
    });
});
