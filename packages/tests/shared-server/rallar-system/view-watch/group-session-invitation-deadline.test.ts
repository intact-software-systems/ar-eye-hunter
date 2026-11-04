import { computeGroupSessionDeadlines, decodeGroupSessionDeadline } from '@shared-server/rallar-system/group-state/schedule/group-session-deadline.ts';
import type { GroupMember } from '@shared/api/group-types.ts';
import { expect, it } from 'vitest';
import { createTestGroup } from '../../../create-test-group.ts';

it('arms a changed invitation expiry between canonical schedule phases even when the schedule is unchanged', () => {
    const group = createTestGroup({ metadata: { rallarSessionSchedule: { revision: 1, startsAtEpochMs: 2000000, cancelledAtEpochMs: null } } });
    const member: GroupMember = {
        applicationId: group.applicationId,
        workspaceId: group.workspaceId,
        groupId: group.groupId,
        principalId: 'bob',
        role: 'member',
        status: 'invited',
        joined: null,
        left: null,
        removed: null,
        banned: null,
        invitedByPrincipalId: 'alice',
        invitationExpiresAtEpochMs: 1600000,
        updated: group.updated
    };
    const input = {
        before: group,
        after: group,
        changedMembers: [member],
        previousMembers: [],
        createdAtEpochMs: 1500000,
        retentionMs: 60000,
        serviceId: 'test',
        traceId: 'test'
    };
    const rows = computeGroupSessionDeadlines(input);
    expect(rows).toHaveLength(1);
    expect(decodeGroupSessionDeadline(JSON.parse(JSON.parse(rows[0].entry.resource).payload.resource))).toMatchObject({
        kind: 'invitation-expire',
        principalId: 'bob',
        dueAtEpochMs: 1600000
    });
    expect(computeGroupSessionDeadlines({ ...input, previousMembers: [member] })).toEqual([]);
});

import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { GroupSessionDirectory } from '@shared-server/rallar-system/group-state/schedule/group-session-directory.ts';
import { GROUP_SESSION_RESERVATIONS_NAMESPACE } from '@shared-server/rallar-system/group-state/schedule/group-session-reservation-storage.ts';
import { decodePersistedALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { decodeViewInvalidationMessage } from '@shared/api/views/view-invalidation.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { createResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';
import { createAppInboxTestResilience } from '../app-inbox/test-support/app-inbox-resource-fixtures.ts';
import { createViewWatchTestRuntime, ref, viewWatchCommand } from './view-watch-test-runtime.ts';

it('invalidates an invited preview at its independent expiry after rescheduling and rejects a renewed invitation predecessor', async () => {
    const storage = await createResourceInboxTestStorage('session_invitation_expiry');
    try {
        const test = await createViewWatchTestRuntime(storage);
        const current = (await test.party.groups.findGroupEntry(ref))!;
        const group = {
            ...current.value,
            joinMode: 'invite-only' as const,
            metadata: {
                ...current.value.metadata,
                rallarSessionSchedule: { revision: 1, startsAtEpochMs: test.party.clock.now + 120000, cancelledAtEpochMs: null }
            }
        };
        await test.party.groups.updateGroup(group, current.entry.revision);
        const member: GroupMember = {
            ...ref,
            principalId: 'bob',
            role: 'member',
            status: 'invited',
            joined: null,
            left: null,
            removed: null,
            banned: null,
            invitedByPrincipalId: 'alice',
            invitationExpiresAtEpochMs: test.party.clock.now + 1000,
            updated: group.updated
        };
        await test.party.groups.putMember({
            ...member,
            principalId: 'alice',
            role: 'owner',
            status: 'active',
            joined: group.created,
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null
        });
        await test.party.groups.putMember(member);
        await test.party.runtime.upsert({
            namespace: GROUP_SESSION_RESERVATIONS_NAMESPACE,
            key: groupStateGroupStorageKey(ref),
            value: JSON.stringify({ ...ref, scheduleRevision: 1, principalIds: [] }),
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
        });
        const rows = computeGroupSessionDeadlines({
            before: group,
            after: group,
            changedMembers: [member],
            previousMembers: [],
            createdAtEpochMs: test.party.clock.now,
            retentionMs: 60000,
            serviceId: 'test',
            traceId: 'test'
        });
        const deadline = decodeGroupSessionDeadline(JSON.parse(JSON.parse(rows[0].entry.resource).payload.resource));
        const directory = new GroupSessionDirectory({ repository: test.party.groups, now: () => test.party.clock.now });
        expect(await directory.read(ref, 'bob')).toMatchObject({ canReserve: true, canEnter: true, timing: { phase: 'lobby' } });
        await test.run(viewWatchCommand(test, 'watch', null));
        const previous = (await test.party.groups.findGroupEntry(ref))!;
        await test.party.groups.updateGroup({
            ...previous.value,
            metadata: {
                ...previous.value.metadata,
                rallarSessionSchedule: { revision: 2, startsAtEpochMs: test.party.clock.now + 180000, cancelledAtEpochMs: null }
            }
        }, previous.entry.revision);
        await test.party.runtime.upsert({
            namespace: GROUP_SESSION_RESERVATIONS_NAMESPACE,
            key: groupStateGroupStorageKey(ref),
            value: JSON.stringify({ ...ref, scheduleRevision: 2, principalIds: [] }),
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
        });
        test.party.clock.now += 1000;
        const admission = await test.deadlines.wake.enqueue({ command: deadline, traceId: 'invite-expiry' });
        await test.party.queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
        expect((await admission.right!.wait()).left).toBeUndefined();
        expect(await directory.read(ref, 'bob')).toMatchObject({
            canReserve: false,
            canEnter: false,
            admissionDenial: 'group-invite-expired',
            timing: { phase: 'lobby' }
        });
        const notices = await storage.sql<readonly { ri_resource: string; }[]>`select ri_resource from resource_inbox where ri_topic_id = 'view.invalidated'`;
        expect(notices.map(({ ri_resource }) => decodeViewInvalidationMessage(decodePersistedALMessageValue(JSON.parse(ri_resource))).principalId)).toContain(
            'bob'
        );
        await test.party.groups.putMember({ ...member, invitationExpiresAtEpochMs: test.party.clock.now + 1000 });
        expect(test.deadlines.compute(await test.deadlines.read(deadline, 'renewed'))).toBeNull();
    }
    finally {
        await storage.close();
    }
});
