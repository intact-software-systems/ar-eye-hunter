import { describe, expect, it } from 'vitest';

import { toScopedGroupMutationCommandId } from '@shared-server/rallar-system/group-state/scoped-group-mutation-command-id.ts';

import type { GroupMutationDescriptor } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';

const descriptor: GroupMutationDescriptor = {
    operation: 'updateGroup',
    scope: { applicationId: 'scope-app', workspaceId: 'scope-workspace' },
    groupId: 'scope-group',
    targetPrincipalId: null,
    sessionId: null,
    request: {
        displayName: 'Scoped group',
        actorPrincipalId: 'owner',
        actorSessionId: 'owner-session-1',
        requestId: 'same-logical-request-001'
    }
};

describe('scoped group AppInbox command identity', () => {
    it('survives an authenticated session renewal for the same stable principal', async () => {
        await expect(toScopedGroupMutationCommandId(descriptor, 'owner')).resolves.toBe(
            await toScopedGroupMutationCommandId(
                {
                    ...descriptor,
                    request: { ...descriptor.request, actorSessionId: 'owner-session-2' }
                },
                'owner'
            )
        );
    });

    it('isolates operation, caller, target, and group scope with a bounded opaque key', async () => {
        const baseline = await toScopedGroupMutationCommandId(descriptor, 'owner');
        const variants = await Promise.all([
            toScopedGroupMutationCommandId({ ...descriptor, operation: 'appointDirector' }, 'owner'),
            toScopedGroupMutationCommandId(descriptor, 'other-owner'),
            toScopedGroupMutationCommandId(
                { ...descriptor, targetPrincipalId: 'target-principal' },
                'owner'
            ),
            toScopedGroupMutationCommandId({ ...descriptor, groupId: 'other-group' }, 'owner')
        ]);

        expect(baseline).toMatch(/^group-app-inbox:[0-9a-f]{64}$/);
        expect(baseline.length).toBeLessThanOrEqual(128);
        expect(new Set([baseline, ...variants])).toHaveLength(variants.length + 1);
    });
});
