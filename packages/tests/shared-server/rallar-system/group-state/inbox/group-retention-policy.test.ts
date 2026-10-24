import { describe, expect, it } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { matchesGroupDirectoryQuery } from '@shared-server/rallar-system/group-state/directory/compute-group-directory-page.ts';
import type { AuthenticatedGroupMutationEnqueue } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import { validateGroupMutationRequest } from '@shared-server/rallar-system/group-state/mutation/command-validation/group-mutation-request-validation.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { GROUPS_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { computeGroupPresenceSummary } from '@shared-server/rallar-system/group-state/presence/compute-group-presence-summary.ts';
import type { CreateGroupRequest, UpdateGroupRequest } from '@shared/api/state-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { presenceConnectEnqueue } from './group-state-inbox-presence-fixtures.ts';
import {
    createAuthorityHarness,
    createResilience,
    processAuthenticated,
    requireGroupStateResult,
    SCOPE,
    waitForQueueEntry,
    type AuthorityHarness
} from './group-state-inbox-test-runtime.ts';

const ROOM_REF = { ...SCOPE, groupId: 'temporary-room' };
const TEMPORARY_STATE = {
    mode: 'temporary',
    reconnectGraceMs: 600_000,
    emptyPresenceFingerprint: null
};

describe('room retention policy through AppInbox', () => {
    it('keeps creation without retention persistent', async () => {
        const harness = await createAuthorityHarness(['owner']);
        const created = requireGroupStateResult(await createRoom(harness));

        expect(created.result.snapshot.group.metadata).toEqual({});
        expect(created.result.snapshot.group.emptySinceEpochMs).toBeNull();
    });

    it('normalizes temporary intent once and replays its original result', async () => {
        const harness = await createAuthorityHarness(['owner']);
        const request = { retention: { mode: 'temporary' as const } };
        const created = requireGroupStateResult(await createRoom(harness, request));
        const replayed = requireGroupStateResult(await createRoom(harness, request));

        expect(created.result.snapshot.group.metadata).toEqual({ rallarRetention: TEMPORARY_STATE });
        expect(created.result.snapshot.group.emptySinceEpochMs).toBeNull();
        expect(replayed).toEqual(created);
        expect(await harness.repository.listEvents(ROOM_REF)).toHaveLength(1);
        await expect(createRoom(harness, { retention: { mode: 'temporary', reconnectGraceMs: 1_000 } }))
            .rejects.toMatchObject({ status: 409 });
    });

    it('accepts an explicit persistent choice and custom temporary grace', async () => {
        const persistent = await createAuthorityHarness(['owner']);
        const temporary = await createAuthorityHarness(['owner']);
        const persistentResult = requireGroupStateResult(await createRoom(persistent, { retention: { mode: 'persistent' } }));
        const temporaryResult = requireGroupStateResult(
            await createRoom(temporary, {
                retention: { mode: 'temporary', reconnectGraceMs: 1_000 }
            })
        );

        expect(persistentResult.result.snapshot.group.metadata).toEqual({});
        expect(temporaryResult.result.snapshot.group.metadata).toEqual({
            rallarRetention: { ...TEMPORARY_STATE, reconnectGraceMs: 1_000 }
        });
    });

    it('preserves temporary retention when replacing unrelated metadata', async () => {
        const harness = await createAuthorityHarness(['owner']);
        await createRoom(harness, { retention: { mode: 'temporary' }, metadata: { theme: 'forest' } });
        const updated = requireGroupStateResult(
            await updateRoom(harness, {
                requestId: 'replace-metadata',
                metadata: { theme: 'ocean' }
            })
        );

        expect(updated.result.snapshot.group.metadata).toEqual({ theme: 'ocean', rallarRetention: TEMPORARY_STATE });
        const spoofed = requireGroupStateResult(
            await updateRoom(harness, {
                requestId: 'replace-with-spoof',
                metadata: { rallarRetention: { mode: 'persistent' } }
            })
        );
        expect(spoofed.result.snapshot.group.metadata).toEqual({ rallarRetention: TEMPORARY_STATE });
    });

    it('does not let metadata replacement install retention in a persistent room', async () => {
        const harness = await createAuthorityHarness(['owner']);
        await createRoom(harness);
        const updated = requireGroupStateResult(
            await updateRoom(harness, {
                requestId: 'inject-policy',
                metadata: { theme: 'ocean', rallarRetention: TEMPORARY_STATE }
            })
        );

        expect(updated.result.snapshot.group.metadata).toEqual({ theme: 'ocean' });
    });

    it.each(['expiresAtEpochMs', 'purgeAfterEpochMs', 'emptySinceEpochMs'] as const)(
        'denies external %s on a temporary room without writing',
        async (field) => {
            const harness = await createAuthorityHarness(['owner']);
            await createRoom(harness, { retention: { mode: 'temporary' } });
            const before = await harness.repository.readSnapshot(ROOM_REF);
            const denied = await updateRoom(harness, { requestId: `set-${field}`, [field]: harness.nowEpochMs + 60_000 });

            expect(denied.left).toMatchObject({ code: 'group-mutation-rejected' });
            expect(await harness.repository.readSnapshot(ROOM_REF)).toEqual(before);
            expect(await harness.repository.listEvents(ROOM_REF)).toHaveLength(1);
        }
    );

    it('allows the owner to archive a temporary room intentionally', async () => {
        const harness = await createAuthorityHarness(['owner']);
        await createRoom(harness, { retention: { mode: 'temporary' } });
        const archived = requireGroupStateResult(await updateRoom(harness, { requestId: 'archive-now', status: 'archived' }));

        expect(archived.result.snapshot.group.status).toBe('archived');
        expect(archived.result.snapshot.group.metadata).toEqual({ rallarRetention: TEMPORARY_STATE });
    });
});

describe('temporary room discovery', () => {
    it('hides an empty temporary room from discovery and Quick Join while admitting its scoped link', async () => {
        const harness = await createAuthorityHarness(['owner', 'guest']);
        const created = requireGroupStateResult(await createRoom(harness, { retention: { mode: 'temporary' } }));

        expect(matchesGroupDirectoryQuery(created.result.snapshot, { kind: null, q: null, includeEmpty: true })).toBe(false);
        expect(await quickJoin(harness)).toEqual({ status: 'unavailable' });
        const joined = await processAuthenticated({
            service: harness.service,
            reader: harness.reader,
            authority: harness.sessions.guest,
            input: {
                type: AppInboxType.GROUP_JOIN,
                resourceId: 'join-link',
                contextId: ROOM_REF.groupId,
                data: { scope: SCOPE, groupId: ROOM_REF.groupId, request: { requestId: 'join-link' } }
            }
        });
        expect(requireGroupStateResult(joined).result.snapshot.members)
            .toContainEqual(expect.objectContaining({ principalId: 'guest', status: 'active' }));
    });

    it('lists a live temporary room after its presence summary converges', async () => {
        const harness = await createAuthorityHarness(['owner', 'guest']);
        await createRoom(harness, { retention: { mode: 'temporary' } });
        const connected = await processAsOwner(harness, presenceConnectEnqueue(ROOM_REF.groupId, 'owner', harness.nowEpochMs));
        expect(connected.left).toBeUndefined();
        const observed = await harness.repository.readPresenceSummaryEntries(ROOM_REF);
        if (observed.status !== 'stable' || observed.group === undefined || observed.current === undefined) {
            throw new Error('Expected the created group and its initial summary');
        }
        expect(observed.presenceSessions).toHaveLength(1);
        expect(observed.current.value.activeSessionCount).toBe(0);
        const computed = computeGroupPresenceSummary({
            ref: ROOM_REF,
            read: { ...observed, group: observed.group, current: observed.current },
            nowEpochMs: harness.nowEpochMs
        });
        if (computed.outcome !== 'write' || computed.operation !== 'update') {
            throw new Error('Expected the admitted connection to advance the presence summary');
        }
        expect(computed.summary.activeSessionCount).toBe(1);
        expect(await harness.repository.updatePresenceSummary(computed.summary, computed.expectedRevision))
            .toMatchObject({ status: 'applied' });

        expect(await quickJoin(harness)).toMatchObject({ status: 'joined', snapshot: { group: ROOM_REF } });
    });
});

describe('durable retention invariants', () => {
    it.each([
        { metadata: { rallarRetention: null } },
        { metadata: { rallarRetention: { mode: 'temporary', reconnectGraceMs: 1_000 } } },
        { metadata: { rallarRetention: { ...TEMPORARY_STATE, extra: true } } },
        { metadata: { rallarRetention: { ...TEMPORARY_STATE, reconnectGraceMs: 999 } } },
        { metadata: { rallarRetention: { ...TEMPORARY_STATE, emptyPresenceFingerprint: '' } } },
        { metadata: { rallarRetention: { ...TEMPORARY_STATE, emptyPresenceFingerprint: 'observed' } } },
        { emptySinceEpochMs: 1_000 },
        { expiresAtEpochMs: 1_000 },
        { purgeAfterEpochMs: 1_000 }
    ])('rejects corrupt stored retention %j', async (corruption) => {
        const harness = await createAuthorityHarness(['owner']);
        const created = requireGroupStateResult(await createRoom(harness, { retention: { mode: 'temporary' } }));
        await harness.runtimeRepository.upsert(
            GROUPS_NAMESPACE,
            groupStateGroupStorageKey(ROOM_REF),
            JSON.stringify({ ...created.result.snapshot.group, ...corruption }),
            NEVER_EXPIRE_AT_TIMESTAMP
        );

        await expect(harness.repository.readSnapshot(ROOM_REF)).rejects.toMatchObject({
            code: 'group-state-repository-invariant-corruption'
        });
    });
});

describe('retention request validation', () => {
    it.each([
        null,
        true,
        {},
        { mode: 'future' },
        { mode: 'persistent', reconnectGraceMs: 1_000 },
        { mode: 'temporary', reconnectGraceMs: 999 },
        { mode: 'temporary', reconnectGraceMs: 86_400_001 },
        { mode: 'temporary', reconnectGraceMs: 1_000.5 },
        { mode: 'temporary', reconnectGraceMs: '1000' },
        { mode: 'temporary', emptyPresenceFingerprint: 'client-owned' }
    ])('rejects malformed retention intent %j', (retention) => {
        expect(validateCreate({ retention }).length).toBeGreaterThan(0);
    });

    it.each(['expiresAtEpochMs', 'purgeAfterEpochMs'] as const)('rejects temporary creation with %s', (field) => {
        const issues = validateCreate({ retention: { mode: 'temporary' }, [field]: 1_000 });

        expect(issues.some((issue) => issue.message.includes('temporary'))).toBe(true);
    });

    it('rejects raw retention metadata on creation', () => {
        expect(validateCreate({ metadata: { rallarRetention: TEMPORARY_STATE } }).length).toBeGreaterThan(0);
    });
});

function validateCreate(fields: object) {
    return validateGroupMutationRequest('createGroup', {
        requestId: 'create-temporary',
        groupId: ROOM_REF.groupId,
        displayName: 'Temporary room',
        kind: 'room',
        createdByPrincipalId: 'owner',
        actorPrincipalId: 'owner',
        actorSessionId: 'owner-session',
        ...fields
    });
}

function createRoom(harness: AuthorityHarness, request: Partial<CreateGroupRequest> = {}) {
    return processAsOwner(harness, {
        type: AppInboxType.GROUP_CREATE,
        resourceId: 'create-temporary',
        contextId: ROOM_REF.groupId,
        data: {
            scope: SCOPE,
            request: {
                requestId: 'create-temporary',
                groupId: ROOM_REF.groupId,
                displayName: 'Temporary room',
                kind: 'room',
                joinMode: 'open',
                createdByPrincipalId: 'owner',
                ...request
            }
        }
    });
}

function updateRoom(harness: AuthorityHarness, request: UpdateGroupRequest) {
    return processAsOwner(harness, {
        type: AppInboxType.GROUP_UPDATE,
        resourceId: request.requestId,
        contextId: ROOM_REF.groupId,
        data: { scope: SCOPE, groupId: ROOM_REF.groupId, request }
    });
}

function processAsOwner(harness: AuthorityHarness, input: AuthenticatedGroupMutationEnqueue) {
    return processAuthenticated({ service: harness.service, reader: harness.reader, authority: harness.sessions.owner, input });
}

async function quickJoin(harness: AuthorityHarness) {
    const pending = harness.service.processQuickJoinUntilCompletion({
        scope: SCOPE,
        request: { requestId: 'quick-join', includeEmpty: true }
    }, harness.sessions.guest);
    await waitForQueueEntry(harness.queue);
    await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
    return (await pending).fold((failure) => {
        throw new Error(failure.message);
    }, (result) => result);
}
