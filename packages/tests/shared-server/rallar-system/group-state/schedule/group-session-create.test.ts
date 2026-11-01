import { describe, expect, it } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { validateGroupMutationRequest } from '@shared-server/rallar-system/group-state/mutation/command-validation/group-mutation-request-validation.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import type { CreateGroupRequest } from '@shared/api/state-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import {
    createAuthorityHarness,
    processAuthenticated,
    requireGroupStateResult,
    SCOPE,
    type AuthorityHarness
} from '../inbox/group-state-inbox-test-runtime.ts';

const ref = { ...SCOPE, groupId: 'session-room' };

describe('scheduled room creation through AppInbox', () => {
    it('atomically creates the room and private reservation state and replays the accepted result', async () => {
        const harness = await createAuthorityHarness(['owner']);
        const startsAtEpochMs = harness.nowEpochMs + 3_600_000;
        const request = createRequest(startsAtEpochMs);

        const created = requireGroupStateResult(await create(harness, request));
        const replayed = requireGroupStateResult(await create(harness, request));

        expect(created.result.snapshot.group).toMatchObject({
            ownerPrincipalId: 'owner',
            activeMemberCount: 1,
            metadata: {
                rallarSessionSchedule: { revision: 1, startsAtEpochMs, cancelledAtEpochMs: null },
                rallarRetention: { mode: 'temporary' }
            }
        });
        expect((await harness.repository.findSessionReservationsEntry(ref))?.value)
            .toEqual({ ...ref, scheduleRevision: 1, principalIds: [] });
        expect(replayed).toEqual(created);
        expect(await harness.repository.listEvents(ref)).toHaveLength(1);
    });

    it('uses the private reservation read for actual AppInbox joins and preserves the last seat', async () => {
        const harness = await createAuthorityHarness(['owner', 'alice', 'bob']);
        requireGroupStateResult(
            await create(harness, {
                ...createRequest(harness.nowEpochMs + 30_000),
                maxMembers: 2
            })
        );
        await harness.runtimeRepository.upsert(
            'group-state:session-reservations',
            groupStateGroupStorageKey(ref),
            JSON.stringify({ ...ref, scheduleRevision: 1, principalIds: ['alice'] }),
            NEVER_EXPIRE_AT_TIMESTAMP
        );

        const denied = await join(harness, 'bob');
        expect(denied.left).toMatchObject({ code: 'group-full' });
        const admitted = requireGroupStateResult(await join(harness, 'alice'));
        expect(admitted.result.snapshot.members).toContainEqual(expect.objectContaining({ principalId: 'alice', status: 'active' }));
        expect(admitted.result.snapshot.group.activeMemberCount).toBe(2);
    });

    it.each([1, 65])('refuses capacity %i that breaks a scheduled reservation', async (maxMembers) => {
        const harness = await createAuthorityHarness(['owner']);
        requireGroupStateResult(await create(harness, createRequest(harness.nowEpochMs + 3_600_000)));
        await harness.runtimeRepository.upsert(
            'group-state:session-reservations',
            groupStateGroupStorageKey(ref),
            JSON.stringify({ ...ref, scheduleRevision: 1, principalIds: ['alice'] }),
            NEVER_EXPIRE_AT_TIMESTAMP
        );

        const denied = await processAuthenticated({
            service: harness.service,
            reader: harness.reader,
            authority: harness.sessions.owner,
            input: {
                traceId: 'scheduled-session-capacity-test',
                type: AppInboxType.GROUP_UPDATE,
                resourceId: 'change-capacity',
                contextId: ref.groupId,
                data: { scope: SCOPE, groupId: ref.groupId, request: { requestId: 'change-capacity', maxMembers } }
            }
        });

        expect(denied.left).toMatchObject({ code: 'group-mutation-rejected' });
        expect((await harness.repository.findGroup(ref))?.maxMembers).toBe(4);
        expect((await harness.repository.findSessionReservationsEntry(ref))?.value.principalIds).toEqual(['alice']);
    });

    it('refuses a start instant that has already passed at the mutation attempt', async () => {
        const harness = await createAuthorityHarness(['owner']);

        const denied = await create(harness, createRequest(harness.nowEpochMs));

        expect(denied.left).toMatchObject({ code: 'group-mutation-rejected' });
        expect(await harness.repository.findGroup(ref)).toBeUndefined();
        expect(await harness.repository.findSessionReservationsEntry(ref)).toBeUndefined();
    });

    it.each([
        { maxMembers: undefined },
        { maxMembers: 65 },
        { retention: undefined },
        { retention: { mode: 'persistent' } },
        { kind: 'team' }
    ])('rejects scheduling without bounded room lifetime and capacity %j', (invalid) => {
        const request = {
            ...createRequest(3_600_000),
            actorPrincipalId: 'owner',
            actorSessionId: 'owner-session',
            ...invalid
        };
        const sparse = Object.fromEntries(Object.entries(request).filter(([, value]) => value !== undefined));
        expect(validateGroupMutationRequest('createGroup', sparse).length).toBeGreaterThan(0);
    });
});

function createRequest(scheduledStartAtEpochMs: number): CreateGroupRequest {
    return {
        requestId: 'create-session',
        groupId: ref.groupId,
        displayName: 'Saturday session',
        kind: 'room',
        joinMode: 'open',
        directoryListing: 'unlisted',
        retention: { mode: 'temporary' },
        maxMembers: 4,
        scheduledStartAtEpochMs,
        createdByPrincipalId: 'owner'
    };
}

function create(harness: AuthorityHarness, request: CreateGroupRequest) {
    return processAuthenticated({
        service: harness.service,
        reader: harness.reader,
        authority: harness.sessions.owner,
        input: {
            traceId: 'scheduled-session-create-test',
            type: AppInboxType.GROUP_CREATE,
            resourceId: request.requestId,
            contextId: ref.groupId,
            data: { scope: SCOPE, request }
        }
    });
}

function join(harness: AuthorityHarness, principalId: string) {
    return processAuthenticated({
        service: harness.service,
        reader: harness.reader,
        authority: harness.sessions[principalId],
        input: {
            traceId: 'scheduled-session-admission-test',
            type: AppInboxType.GROUP_JOIN,
            resourceId: `join-${principalId}`,
            contextId: ref.groupId,
            data: { scope: SCOPE, groupId: ref.groupId, request: { requestId: `join-${principalId}` } }
        }
    });
}
