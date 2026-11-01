import { computeGroupCohortAdmission } from '@shared-server/rallar-system/group-state/mutation/membership/compute-group-cohort-admission.ts';
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
});
