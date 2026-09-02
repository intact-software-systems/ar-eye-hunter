import { describe, expect, it } from 'vitest';

import { validateStoredGroup } from '@shared-server/rallar-system/group-state/persistence/validate-persisted-group.ts';
import { GROUP_LIFECYCLE_STATES } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import { createTestGroup } from '../../../../create-test-group.ts';

const GROUP_REF = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'group-1'
} as const;

// The stored-value gate derives from the stage registry, so a half-landed
// stage edit fails here instead of only at runtime in the black-box recipes.
describe('stored group lifecycleState acceptance', () => {
    it.each([...GROUP_LIFECYCLE_STATES])('accepts a stored group in %s', (lifecycleState) => {
        const group = createTestGroup({ ...GROUP_REF, lifecycleState });

        expect(validateStoredGroup(group, GROUP_REF)).toEqual([]);
    });

    it('rejects the retired establishing value', () => {
        const group = { ...createTestGroup(GROUP_REF), lifecycleState: 'establishing' };

        expect(validateStoredGroup(group, GROUP_REF).map((issue) => issue.cause.message))
            .toEqual(expect.arrayContaining([expect.stringContaining('Stored group lifecycleState')]));
    });
});
