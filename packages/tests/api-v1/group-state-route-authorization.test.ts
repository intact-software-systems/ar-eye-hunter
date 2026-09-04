import { describe, expect, it } from 'vitest';

import { requireApiAuthSession } from '@shared-server/http/request-auth-service.ts';
import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { GroupStateWritten } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { createCachedGroupStateService, type CachedGroupStateService } from '@shared-server/rallar-system/group-state/snapshot/cached-group-state-service.ts';
import { createGroupStateSnapshotReadThroughCache } from '@shared-server/rallar-system/group-state/snapshot/group-state-snapshot-read-through-cache.ts';

import { createGroupStateRouteAuthorization, type GroupStateRouteAuthorization } from '../../../apps/api-v1/src/group-state/group-state-route-authorization.ts';
import { configureTestCacheRepositories } from '../configure-test-cache-repositories.ts';
import {
    createAuthorityHarness,
    createRoom,
    processAuthenticated,
    requireGroupStateResult,
    SCOPE,
    type AuthorityHarness
} from '../shared-server/rallar-system/group-state/inbox/group-state-inbox-test-runtime.ts';

interface CachedRouteAuthority {
    readonly service: CachedGroupStateService;
    readonly authorization: GroupStateRouteAuthorization;
}

describe('group mutation route authorization with stale cached membership', () => {
    it('allows an immediate admin update after an owner grants the role through AppInbox', async () => {
        const groupId = 'route-admin-grant';
        const ref = { ...SCOPE, groupId };
        const harness = await createMemberHarness(groupId);
        const cached = createCachedRouteAuthority(harness);
        const before = await cached.service.readSnapshot(ref);
        expect(before?.members.find((member) => member.principalId === 'alice')?.role).toBe('member');

        const granted = await setAliceRole(harness, groupId, 'admin');
        expect(granted.result.snapshot.members.find((member) => member.principalId === 'alice')?.role).toBe('admin');
        expect(await cached.service.readSnapshot(ref)).toEqual(before);

        await expect(cached.authorization.assertCanUpdateGroup('alice', ref)).resolves.toBeUndefined();
        const updated = requireGroupStateResult(await updateAsAlice(harness, groupId, 'Admin updated immediately'));

        expect(updated.result.snapshot.group.displayName).toBe('Admin updated immediately');
        expect((await harness.repository.readSnapshot(ref))?.group.displayName).toBe('Admin updated immediately');
        expect(await cached.service.readSnapshot(ref)).toEqual(before);
    });

    it('rejects a revoked admin despite a cached admin role and preserves domain rejection', async () => {
        const groupId = 'route-admin-revocation';
        const ref = { ...SCOPE, groupId };
        const harness = await createMemberHarness(groupId);
        await setAliceRole(harness, groupId, 'admin');
        const cached = createCachedRouteAuthority(harness);
        const before = await cached.service.readSnapshot(ref);
        expect(before?.members.find((member) => member.principalId === 'alice')?.role).toBe('admin');

        const revoked = await setAliceRole(harness, groupId, 'member');
        expect(revoked.result.snapshot.members.find((member) => member.principalId === 'alice')?.role).toBe('member');
        expect(await cached.service.readSnapshot(ref)).toEqual(before);

        await expect(cached.authorization.assertCanUpdateGroup('alice', ref)).rejects.toMatchObject({
            code: 'authorization-denied',
            status: 403
        });
        const eventsBefore = await harness.repository.listEvents(ref);
        const denied = await updateAsAlice(harness, groupId, 'Must not be written');

        expect(denied.left).toMatchObject({ code: 'forbidden-role', status: 403 });
        expect(await harness.repository.readSnapshot(ref)).toEqual(revoked.result.snapshot);
        expect(await harness.repository.listEvents(ref)).toEqual(eventsBefore);
        expect(await cached.service.readSnapshot(ref)).toEqual(before);
    });
});

async function createMemberHarness(groupId: string): Promise<AuthorityHarness> {
    const harness = await createAuthorityHarness(['owner', 'alice']);
    await createRoom(harness, groupId, 'Before role change');
    requireGroupStateResult(
        await processAuthenticated({
            service: harness.service,
            reader: harness.reader,
            authority: harness.sessions.alice,
            input: {
                type: AppInboxType.GROUP_JOIN,
                resourceId: `${groupId}-join`,
                contextId: groupId,
                senderId: 'alice',
                data: {
                    scope: SCOPE,
                    groupId,
                    request: { actorPrincipalId: 'alice', actorSessionId: 'alice-session', requestId: `${groupId}-join` }
                }
            }
        })
    );
    return harness;
}

function createCachedRouteAuthority(harness: AuthorityHarness): CachedRouteAuthority {
    configureTestCacheRepositories();
    const cache = createGroupStateSnapshotReadThroughCache({ groupsRepository: harness.repository });
    const service = createCachedGroupStateService({ durable: harness.groupStateService, cache });
    return {
        service,
        authorization: createGroupStateRouteAuthorization({
            groupStateService: service,
            requireApiAuthSession: (request) => requireApiAuthSession(request, harness.authSessions),
            strictReadAuthorization: true
        })
    };
}

async function setAliceRole(
    harness: AuthorityHarness,
    groupId: string,
    role: 'admin' | 'member'
): Promise<GroupStateWritten> {
    return requireGroupStateResult(
        await processAuthenticated({
            service: harness.service,
            reader: harness.reader,
            authority: harness.sessions.owner,
            input: {
                type: AppInboxType.GROUP_MEMBER_ROLE_SET,
                resourceId: `${groupId}-${role}`,
                contextId: groupId,
                senderId: 'owner',
                data: {
                    scope: SCOPE,
                    groupId,
                    principalId: 'alice',
                    request: { role, actorPrincipalId: 'owner', actorSessionId: 'owner-session', requestId: `${groupId}-${role}` }
                }
            }
        })
    );
}

async function updateAsAlice(harness: AuthorityHarness, groupId: string, displayName: string) {
    return await processAuthenticated({
        service: harness.service,
        reader: harness.reader,
        authority: harness.sessions.alice,
        input: {
            type: AppInboxType.GROUP_UPDATE,
            resourceId: `${groupId}-update`,
            contextId: groupId,
            senderId: 'alice',
            data: {
                scope: SCOPE,
                groupId,
                request: { displayName, actorPrincipalId: 'alice', actorSessionId: 'alice-session', requestId: `${groupId}-update` }
            }
        }
    });
}
