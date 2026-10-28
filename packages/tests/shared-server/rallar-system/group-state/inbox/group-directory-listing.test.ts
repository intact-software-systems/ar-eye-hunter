import { describe, expect, it } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { AuthenticatedGroupMutationEnqueue } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import { validateGroupMutationRequest } from '@shared-server/rallar-system/group-state/mutation/command-validation/group-mutation-request-validation.ts';
import { isGroupDirectoryVisible } from '@shared-server/rallar-system/group-state/policy/group-snapshot-visibility-policy.ts';
import type { CreateGroupRequest, UpdateGroupRequest } from '@shared/api/state-types.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import {
    createAuthorityHarness,
    createResilience,
    processAuthenticated,
    requireGroupStateResult,
    SCOPE,
    waitForQueueEntry,
    type AuthorityHarness
} from './group-state-inbox-test-runtime.ts';

const ROOM_REF = { ...SCOPE, groupId: 'shared-link-room' };

describe('group directory listing through AppInbox', () => {
    it('hides an unlisted open room from discovery and Quick Join while admitting its scoped link', async () => {
        const harness = await createAuthorityHarness(['owner', 'guest']);
        const created = await createRoom(harness, { metadata: { rallarDirectoryListing: 'unlisted' } });
        const snapshot = requireGroupStateResult(created).result.snapshot;

        expect(isGroupDirectoryVisible({ snapshot, actor: { principalId: 'guest' } })).toBe(false);
        expect(await quickJoin(harness)).toEqual({ status: 'unavailable' });
        const joined = await processAs(harness, 'guest', {
            traceId: 'trace-test-fixture',
            type: AppInboxType.GROUP_JOIN,
            resourceId: 'join-by-link',
            contextId: ROOM_REF.groupId,
            data: { scope: SCOPE, groupId: ROOM_REF.groupId, request: { requestId: 'join-by-link' } }
        });
        expect(requireGroupStateResult(joined).result.snapshot.members)
            .toContainEqual(expect.objectContaining({ principalId: 'guest', status: 'active' }));
    });

    it('keeps an open room with no listing setting discoverable', async () => {
        const harness = await createAuthorityHarness(['owner', 'guest']);
        const snapshot = requireGroupStateResult(await createRoom(harness)).result.snapshot;

        expect(snapshot.group.metadata).toEqual({});
        expect(isGroupDirectoryVisible({ snapshot, actor: { principalId: 'guest' } })).toBe(true);
        expect(await quickJoin(harness)).toMatchObject({ status: 'joined', snapshot: { group: ROOM_REF } });
    });

    it.each(['code', 'invite-only'] as const)('keeps a listed %s room private', async (joinMode) => {
        const harness = await createAuthorityHarness(['owner', 'guest']);
        const created = await createRoom(harness, { joinMode, metadata: { rallarDirectoryListing: 'listed' } });
        const snapshot = requireGroupStateResult(created).result.snapshot;

        expect(isGroupDirectoryVisible({ snapshot, actor: { principalId: 'guest' } })).toBe(false);
        expect(await quickJoin(harness)).toEqual({ status: 'unavailable' });
    });

    it('creates an unlisted room through explicit intent without changing admission', async () => {
        const harness = await createAuthorityHarness(['owner', 'guest']);
        const created = await createRoom(harness, {
            directoryListing: 'unlisted',
            metadata: { theme: 'forest', rallarDirectoryListing: 'listed' }
        });
        const snapshot = requireGroupStateResult(created).result.snapshot;

        expect(snapshot.group.metadata).toEqual({ theme: 'forest', rallarDirectoryListing: 'unlisted' });
        expect(snapshot.group.joinMode).toBe('open');
        expect(isGroupDirectoryVisible({ snapshot, actor: { principalId: 'guest' } })).toBe(false);
    });

    it('replays the original hiding result after relisting and rejects changed request semantics', async () => {
        const harness = await createAuthorityHarness(['owner']);
        const before = requireGroupStateResult(await createRoom(harness, { metadata: { theme: 'forest' } })).result.snapshot;
        const request: UpdateGroupRequest = { requestId: 'hide-room', directoryListing: 'unlisted' };
        const hidden = requireGroupStateResult(await updateRoom(harness, request));
        const relisted = requireGroupStateResult(
            await updateRoom(harness, {
                requestId: 'list-room',
                directoryListing: 'listed'
            })
        );
        const replay = requireGroupStateResult(await updateRoom(harness, request));

        expect(hidden.result.snapshot.group.metadata).toEqual({ theme: 'forest', rallarDirectoryListing: 'unlisted' });
        expect(hidden.result.snapshot.members).toEqual(before.members);
        expect(hidden.result.snapshot.activeSessions).toEqual(before.activeSessions);
        expect(replay).toEqual(hidden);
        expect(await harness.repository.readSnapshot(ROOM_REF)).toEqual(relisted.result.snapshot);
        expect((await harness.repository.listEvents(ROOM_REF)).filter((event) => event.eventType === 'group-updated'))
            .toHaveLength(2);
        await expect(updateRoom(harness, { ...request, directoryListing: 'listed' })).rejects.toMatchObject({ status: 409 });
    });

    it('preserves hidden listing when an unrelated metadata replacement carries an old listing', async () => {
        const harness = await createAuthorityHarness(['owner']);
        await createRoom(harness, { metadata: { theme: 'forest', rallarDirectoryListing: 'unlisted' } });

        const updated = requireGroupStateResult(
            await updateRoom(harness, {
                requestId: 'replace-metadata',
                metadata: { theme: 'ocean', rallarDirectoryListing: 'listed' }
            })
        );
        const replacedAgain = requireGroupStateResult(
            await updateRoom(harness, {
                requestId: 'replace-without-listing',
                metadata: { theme: 'desert' }
            })
        );

        expect(updated.result.snapshot.group.metadata).toEqual({ theme: 'ocean', rallarDirectoryListing: 'unlisted' });
        expect(replacedAgain.result.snapshot.group.metadata).toEqual({ theme: 'desert', rallarDirectoryListing: 'unlisted' });
    });

    it('does not write a second event when the room is already unlisted', async () => {
        const harness = await createAuthorityHarness(['owner']);
        const before = requireGroupStateResult(
            await createRoom(harness, {
                metadata: { rallarDirectoryListing: 'unlisted' }
            })
        ).result.snapshot;

        const updated = requireGroupStateResult(
            await updateRoom(harness, {
                requestId: 'hide-again',
                directoryListing: 'unlisted'
            })
        );

        expect(updated.result).toEqual({ snapshot: before, event: null });
        expect(await harness.repository.listEvents(ROOM_REF)).toHaveLength(1);
    });

    it('denies a normal member listing authority without changing the room', async () => {
        const harness = await createAuthorityHarness(['owner', 'guest']);
        await createRoom(harness);
        await quickJoin(harness);
        const before = await harness.repository.readSnapshot(ROOM_REF);

        const denied = await updateRoom(harness, { requestId: 'guest-hide', directoryListing: 'unlisted' }, 'guest');

        expect(denied.left).toMatchObject({ code: 'forbidden-role' });
        expect(await harness.repository.readSnapshot(ROOM_REF)).toEqual(before);
    });

    it.each([null, true, 7, {}, 'future-mode'])('rejects a malformed stored listing on create: %j', (listing) => {
        const issues = validateGroupMutationRequest('createGroup', {
            requestId: 'invalid-listing',
            groupId: ROOM_REF.groupId,
            displayName: 'Invalid listing',
            kind: 'room',
            joinMode: 'open',
            createdByPrincipalId: 'owner',
            actorPrincipalId: 'owner',
            actorSessionId: 'owner-session',
            metadata: { rallarDirectoryListing: listing }
        });
        expect(issues.length).toBeGreaterThan(0);
    });

    it('keeps a corrupt present listing out of discovery and Quick Join', async () => {
        const harness = await createAuthorityHarness(['owner', 'guest']);
        const snapshot = requireGroupStateResult(await createRoom(harness)).result.snapshot;
        const corrupt = { ...snapshot.group, metadata: { rallarDirectoryListing: 'future-mode' } };
        await harness.repository.putGroup(corrupt);

        expect(isGroupDirectoryVisible({ snapshot: { ...snapshot, group: corrupt }, actor: { principalId: 'guest' } }))
            .toBe(false);
        expect(await quickJoin(harness)).toEqual({ status: 'unavailable' });
    });
});

function createRoom(harness: AuthorityHarness, request: Partial<CreateGroupRequest> = {}) {
    return processAs(harness, 'owner', {
        traceId: 'trace-test-fixture',
        type: AppInboxType.GROUP_CREATE,
        resourceId: 'create-link-room',
        contextId: ROOM_REF.groupId,
        data: {
            scope: SCOPE,
            request: {
                requestId: 'create-link-room',
                groupId: ROOM_REF.groupId,
                displayName: 'Shared link room',
                kind: 'room',
                joinMode: 'open',
                createdByPrincipalId: 'owner',
                ...request
            }
        }
    });
}

function processAs(harness: AuthorityHarness, principalId: string, input: AuthenticatedGroupMutationEnqueue) {
    return processAuthenticated({
        service: harness.service,
        reader: harness.reader,
        authority: harness.sessions[principalId],
        input
    });
}

async function quickJoin(harness: AuthorityHarness) {
    const pending = harness.service.processQuickJoinUntilCompletion({
        traceId: 'trace-test-fixture',
        scope: SCOPE,
        request: { requestId: 'quick-join', includeEmpty: true }
    }, harness.sessions.guest);
    await waitForQueueEntry(harness.queue);
    await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
    return (await pending).fold((failure) => {
        throw new Error(failure.message);
    }, (result) => result);
}

function updateRoom(harness: AuthorityHarness, request: UpdateGroupRequest, principalId = 'owner') {
    return processAs(harness, principalId, {
        traceId: 'trace-test-fixture',
        type: AppInboxType.GROUP_UPDATE,
        resourceId: request.requestId,
        contextId: ROOM_REF.groupId,
        data: { scope: SCOPE, groupId: ROOM_REF.groupId, request }
    });
}
