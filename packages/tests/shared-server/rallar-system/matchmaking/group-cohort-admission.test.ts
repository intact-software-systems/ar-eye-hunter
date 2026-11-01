import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import {
    computeGroupCohortAdmission,
    computeNewGroupCohortAdmission
} from '@shared-server/rallar-system/group-state/mutation/membership/compute-group-cohort-admission.ts';
import { writeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/write/write-group-mutation.ts';
import { describe, expect, it } from 'vitest';
import { createGroupMoveTestDatabase, DESTINATION } from '../group-state/move/group-move-test-database.ts';

describe('shared cohort admission', () => {
    it('admits a whole player cohort through ordinary membership rules in one transaction', async () => {
        const fixture = await createGroupMoveTestDatabase();
        try {
            const computed = computeGroupCohortAdmission({ participants: await Promise.all([fixture.join('bob'), fixture.join('carol')]) });
            expect(computed.status).toBe('admitted');
            if (computed.status !== 'admitted') {
                throw new Error('Expected cohort admission');
            }
            await fixture.storage.sql.begin(async (transaction) => {
                for (const mutation of computed.mutations) {
                    await writeGroupMutation(transaction, mutation);
                }
            });
            const snapshot = await fixture.repository.readSnapshot(DESTINATION);
            expect(snapshot?.members.filter((member) => member.status === 'active').map((member) => member.principalId).sort())
                .toEqual(['alice', 'bob', 'carol']);
        }
        finally {
            await fixture.storage.close();
        }
    });
    it('creates an exclusive room and all cohort memberships atomically', async () => {
        const fixture = await createGroupMoveTestDatabase();
        const ref = { ...DESTINATION, groupId: 'new-match' };
        try {
            const creation = await fixture.prepare(
                mutationDescriptor({
                    operation: 'createGroup',
                    scope: ref,
                    groupId: ref.groupId,
                    request: {
                        groupId: ref.groupId,
                        requestId: 'match-create',
                        createdByPrincipalId: 'alice',
                        displayName: 'Matched room',
                        kind: 'room',
                        joinMode: 'open',
                        maxMembers: 2,
                        directoryListing: 'unlisted',
                        retention: { mode: 'temporary' }
                    }
                }),
                'alice'
            );
            const joining = await fixture.prepare(
                mutationDescriptor({
                    operation: 'joinGroup',
                    scope: ref,
                    groupId: ref.groupId,
                    request: { requestId: 'match-bob', actorPrincipalId: 'bob', participation: 'player' }
                }),
                'bob'
            );
            if (joining.command.operation !== 'joinGroup') {
                throw new Error('Expected an ordinary join');
            }
            const computed = computeNewGroupCohortAdmission({ creation, participants: [{ ...joining, command: joining.command }] });
            expect(computed.status).toBe('admitted');
            if (computed.status !== 'admitted') {
                throw new Error('Expected complete new-room admission');
            }
            expect(await fixture.repository.readSnapshot(ref)).toBeUndefined();
            await expect(fixture.storage.sql.begin(async (transaction) => {
                await writeGroupMutation(transaction, computed.mutations[0]);
                throw new Error('membership write failed');
            })).rejects.toThrow('membership write failed');
            expect(await fixture.repository.readSnapshot(ref)).toBeUndefined();
            await fixture.storage.sql.begin(async (transaction) => {
                for (const mutation of computed.mutations) {
                    await writeGroupMutation(transaction, mutation);
                }
            });
            const snapshot = await fixture.repository.readSnapshot(ref);
            expect(snapshot?.members.map((member) => member.principalId).sort()).toEqual(['alice', 'bob']);
            expect(snapshot?.group.activeMemberCount).toBe(2);
        }
        finally {
            await fixture.storage.close();
        }
    });
});
