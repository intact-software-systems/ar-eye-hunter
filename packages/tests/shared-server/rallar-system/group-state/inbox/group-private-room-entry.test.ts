import { describe, expect, it } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { AuthenticatedGroupMutationEnqueue } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import type { JoinGroupRequest, RotateGroupJoinCodeRequest, UpdateGroupRequest } from '@shared/api/state-types.ts';

import {
    createAuthorityHarness,
    listRoomEvents,
    processAuthenticated,
    SCOPE,
    type AuthorityHarness
} from './group-state-inbox-test-runtime.ts';

const ROOM_REF = { ...SCOPE, groupId: 'private-room' };

interface ClosedRoomCase {
    readonly label: string;
    readonly request: UpdateGroupRequest;
    readonly code: string;
}

describe('private-room entry through AppInbox', () => {
    it.each(['rotated', 'expired'] as const)(
        'lets an active member return after the code is %s while denying a new entrant with it',
        async (codeState) => {
            let attemptAtEpochMs = Date.now();
            const harness = await createAuthorityHarness(['owner', 'member', 'newcomer'], {
                serviceOptions: { nowEpochMs: () => attemptAtEpochMs }
            });
            attemptAtEpochMs = harness.nowEpochMs;
            await createPrivateRoom(harness);
            await rotateCode(harness, {
                requestId: 'original-code',
                joinCode: 'ORIGINAL',
                expiresAtEpochMs: attemptAtEpochMs + 1_000
            });
            const joined = await joinRoom(harness, 'member', { requestId: 'first-entry', joinCode: 'ORIGINAL' });
            expect(joined.left).toBeUndefined();
            if (codeState === 'rotated') {
                await rotateCode(harness, {
                    requestId: 'replacement-code',
                    joinCode: 'REPLACEMENT',
                    expiresAtEpochMs: attemptAtEpochMs + 60_000
                });
            }
            else {
                attemptAtEpochMs += 2_000;
            }
            const before = await harness.repository.readSnapshot(ROOM_REF);
            const eventsBefore = await listRoomEvents(harness, ROOM_REF.groupId);

            const returned = await joinRoom(harness, 'member', { requestId: 'return-member' });
            const replay = await joinRoom(harness, 'member', { requestId: 'return-member' });
            const denied = await joinRoom(harness, 'newcomer', { requestId: 'new-entry', joinCode: 'ORIGINAL' });

            expect(returned.left).toBeUndefined();
            expect(returned.right).toEqual({ status: 'ok', result: { snapshot: before, event: null } });
            expect(replay.right).toEqual(returned.right);
            expect(denied.left).toMatchObject({ code: 'group-code-invalid' });
            expect(await harness.repository.readSnapshot(ROOM_REF)).toEqual(before);
            expect(await listRoomEvents(harness, ROOM_REF.groupId)).toEqual(eventsBefore);
        }
    );

    it.each(
        [
            { type: AppInboxType.GROUP_MEMBER_REMOVE, code: 'member-removed' },
            { type: AppInboxType.GROUP_MEMBER_BAN, code: 'member-banned' }
        ] as const
    )('does not revive membership denied by $code', async ({ type, code }) => {
        const harness = await createAuthorityHarness(['owner', 'member']);
        await createPrivateRoom(harness);
        await rotateCode(harness, { requestId: 'original-code', joinCode: 'ORIGINAL' });
        expect((await joinRoom(harness, 'member', { requestId: 'first-entry', joinCode: 'ORIGINAL' })).left)
            .toBeUndefined();
        const blocked = await processAs(harness, 'owner', {
            traceId: 'trace-test-fixture',
            type,
            resourceId: 'block-member',
            contextId: ROOM_REF.groupId,
            data: { scope: SCOPE, groupId: ROOM_REF.groupId, principalId: 'member', request: { requestId: 'block-member' } }
        });
        expect(blocked.left).toBeUndefined();
        const before = await harness.repository.readSnapshot(ROOM_REF);
        const eventsBefore = await listRoomEvents(harness, ROOM_REF.groupId);

        const returned = await joinRoom(harness, 'member', { requestId: 'return-member', joinCode: 'ORIGINAL' });

        expect(returned.left).toMatchObject({ code });
        expect(await harness.repository.readSnapshot(ROOM_REF)).toEqual(before);
        expect(await listRoomEvents(harness, ROOM_REF.groupId)).toEqual(eventsBefore);
    });

    it.each(
        [
            { label: 'archived', request: { status: 'archived' }, code: 'group-archived' },
            { label: 'deleted', request: { status: 'deleted' }, code: 'group-deleted' },
            { label: 'expired', request: { expiresAtEpochMs: 1 }, code: 'group-not-active' }
        ] satisfies readonly ClosedRoomCase[]
    )(
        'does not return an active member to an $label room',
        async ({ request, code }) => {
            const harness = await createAuthorityHarness(['owner']);
            await createPrivateRoom(harness);
            const updated = await processAs(harness, 'owner', {
                traceId: 'trace-test-fixture',
                type: AppInboxType.GROUP_UPDATE,
                resourceId: 'close-room',
                contextId: ROOM_REF.groupId,
                data: { scope: SCOPE, groupId: ROOM_REF.groupId, request: { ...request, requestId: 'close-room' } }
            });
            expect(updated.left).toBeUndefined();
            const before = await harness.repository.readSnapshot(ROOM_REF);
            const eventsBefore = await listRoomEvents(harness, ROOM_REF.groupId);

            const returned = await joinRoom(harness, 'owner', { requestId: 'return-owner' });

            expect(returned.left).toMatchObject({ code });
            expect(await harness.repository.readSnapshot(ROOM_REF)).toEqual(before);
            expect(await listRoomEvents(harness, ROOM_REF.groupId)).toEqual(eventsBefore);
        }
    );
});

async function createPrivateRoom(harness: AuthorityHarness) {
    const result = await processAs(harness, 'owner', {
        traceId: 'trace-test-fixture',
        type: AppInboxType.GROUP_CREATE,
        resourceId: 'create-private-room',
        contextId: ROOM_REF.groupId,
        data: {
            scope: SCOPE,
            request: {
                groupId: ROOM_REF.groupId,
                displayName: 'Private room',
                kind: 'room',
                joinMode: 'code',
                createdByPrincipalId: 'owner',
                requestId: 'create-private-room'
            }
        }
    });
    expect(result.left).toBeUndefined();
}

async function rotateCode(harness: AuthorityHarness, request: RotateGroupJoinCodeRequest) {
    const result = await processAs(harness, 'owner', {
        traceId: 'trace-test-fixture',
        type: AppInboxType.GROUP_JOIN_CODE_ROTATE,
        resourceId: request.requestId,
        contextId: ROOM_REF.groupId,
        data: { scope: SCOPE, groupId: ROOM_REF.groupId, request }
    });
    expect(result.left).toBeUndefined();
}

function joinRoom(harness: AuthorityHarness, principalId: string, request: JoinGroupRequest) {
    return processAs(harness, principalId, {
        traceId: 'trace-test-fixture',
        type: AppInboxType.GROUP_JOIN,
        resourceId: request.requestId,
        contextId: ROOM_REF.groupId,
        data: { scope: SCOPE, groupId: ROOM_REF.groupId, request }
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
