import { writeAppOutboxInserts } from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import { AppOutboxType } from '@shared-server/rallar-system/app-outbox/app-outbox-type.ts';
import { GroupLobbyExpiry } from '@shared-server/rallar-system/group-state/lobby/group-lobby-expiry.ts';
import { computeGroupLobbyPublication } from '@shared-server/rallar-system/group-state/lobby/compute-group-lobby-publication.ts';
import { GROUP_LOBBIES_NAMESPACE, GROUP_LOBBY_COMMITMENTS_NAMESPACE, lobbyCommitmentKey } from '@shared-server/rallar-system/group-state/lobby/group-lobby-storage.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { RoomLobby } from '@shared/api/room-lobbies/room-lobby.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import { expect, it } from 'vitest';
import { createTestGroup } from '../../../../create-test-group.ts';
import { createResourceInboxTestStorage } from '../../../queuebox/resource-inbox-test-storage.ts';
import { createSqlServerAppInbox } from '../../../rallar-server/create-test-server-app-inbox.ts';
import { createAppInboxTestResilience } from '../../app-inbox/test-support/app-inbox-resource-fixtures.ts';

it('processes a persisted return window after restart; only the winner releases the account and notifies it', async () => {
    const storage = await createResourceInboxTestStorage('lobby_expiry_recovery');
    try {
        const clock = Date.now() - 240000;
        const runtime = new PSqlRuntimeStateRepository(storage.sql);
        const roomRef = { applicationId: 'game', workspaceId: 'default', groupId: 'room' };
        const groups = new GroupStateRepository(runtime, new PSqlGroupStateEventRepository(storage.sql));
        const group = createTestGroup({ ...roomRef, kind: 'room', maxMembers: 1 });
        await groups.putGroup(group);
        const due = { generation: 3, dueAtEpochMs: clock + 1000 };
        const seat = { principalId: 'alice', present: false, offerWindow: null, returnWindow: due, admissionWindow: null };
        const lobby: RoomLobby = { capacityClaims: null, roomRef, expiresAtEpochMs: null, activationId: 'current', capacity: 1, policy: { returnWindowMs: 1000, claimWindowMs: 1000 }, revision: 3, waiters: [], seats: [seat] };
        await runtime.upsert({ namespace: GROUP_LOBBIES_NAMESPACE, key: groupStateGroupStorageKey(roomRef), value: JSON.stringify(lobby), expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP });
        await runtime.upsert({ namespace: GROUP_LOBBY_COMMITMENTS_NAMESPACE, key: lobbyCommitmentKey(roomRef, 'alice'), value: JSON.stringify({ scope: { applicationId: 'game', workspaceId: 'default' }, principalId: 'alice', seat: { roomRef, status: 'away', deadlineEpochMs: due.dueAtEpochMs } }), expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP });
        const publication = computeGroupLobbyPublication({ before: null, after: lobby, roomRef, groupCreatedAtEpochMs: group.created.atEpochMs,
            createdAtEpochMs: clock, retentionMs: 60000, serviceId: 'api', traceId: 'fill' });
        await storage.sql.begin(transaction => writeAppOutboxInserts(transaction,
            publication.outbox.filter(row => decodePersistedALMessage(row.entry.resource).payload.typeId === AppOutboxType.ROOM_LOBBY_DEADLINE)));
        const nowEpochMs = Date.now;
        const queue = createSqlServerAppInbox({ database: storage.sql, nowEpochMs });
        const service = new GroupLobbyExpiry({ database: storage.sql, appInbox: queue.inbox, groups, nowEpochMs, serviceId: 'api', retentionMs: 60000 });
        service.listen(queue.outbox);
        queue.inbox.start();
        const delivery = createAppInboxTestResilience(0);
        const deadline = { kind: 'seat' as const, roomRef, activationId: 'current', groupCreatedAtEpochMs: group.created.atEpochMs, ...due };
        for (const stale of [{ ...deadline, generation: 2 }, { ...deadline, groupCreatedAtEpochMs: 2 }, { ...deadline, activationId: 'obsolete' }]) {
            const admission = await service.expire.enqueue({ command: stale, traceId: 'obsolete' });
            expect(admission.right).toBeDefined();
            await queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, delivery);
            expect((await groups.findGroupLobbyEntry(roomRef))?.value).toEqual(lobby);
        }
        await queue.outbox.dequeueOutbox(OutboxQueueReader.OUTBOX_DEQUEUE_TYPES, delivery);
        await queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, delivery);
        expect((await groups.findGroupLobbyEntry(roomRef))?.value).toMatchObject({ revision: 4, seats: [] });
        expect(await groups.findLobbyCommitmentEntry(roomRef, 'alice')).toBeUndefined();
        const replay = await service.expire.submit({ command: deadline, traceId: 'replay' });
        expect(replay.right).toMatchObject(due);
        expect((await groups.findGroupLobbyEntry(roomRef))?.value.revision).toBe(4);
        const notices = await storage.sql<readonly { notices: number }[]>`select count(*)::int as notices from resource_inbox where ri_topic_id = 'view.invalidated'`;
        expect(notices[0]?.notices).toBe(1);
        const retained = await storage.sql`select ri_status as status, expire_ts < now() + interval '2 minutes' as bounded
            from resource_inbox where ri_topic_id = 'room-lobby.deadline'`;
        expect(retained).toEqual([{ status: 'COMPLETED', bounded: true }]);
    }
    finally {
        await storage.close();
    }
});

it('releases a hard-expired empty room after SQL evicts its group and retains an account’s newer lobby', async () => {
    const storage = await createResourceInboxTestStorage('lobby_hard_expiry');
    try {
        const now = Date.now();
        const roomRef = { applicationId: 'game', workspaceId: 'default', groupId: 'court' };
        const runtime = new PSqlRuntimeStateRepository(storage.sql);
        const groups = new GroupStateRepository(runtime, new PSqlGroupStateEventRepository(storage.sql));
        const seat = { principalId: 'alice', present: false, offerWindow: null, returnWindow: null, admissionWindow: null };
        const lobby: RoomLobby = { capacityClaims: null, activationId: 'current', expiresAtEpochMs: now - 200, roomRef,
            policy: { claimWindowMs: 5000, returnWindowMs: 120000 }, capacity: 4, revision: 3, waiters: [], seats: [seat] };
        await runtime.upsert({ namespace: GROUP_LOBBIES_NAMESPACE, key: groupStateGroupStorageKey(roomRef),
            value: JSON.stringify(lobby), expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP });
        const scope = { applicationId: roomRef.applicationId, workspaceId: roomRef.workspaceId };
        const newSeat = { roomRef: { ...roomRef, groupId: 'other' }, status: 'present', deadlineEpochMs: null };
        await runtime.upsert({ namespace: GROUP_LOBBY_COMMITMENTS_NAMESPACE, key: lobbyCommitmentKey(scope, 'alice'),
            value: JSON.stringify({ scope, principalId: 'alice', seat: newSeat }), expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP });
        const queue = createSqlServerAppInbox({ database: storage.sql, nowEpochMs: Date.now });
        const service = new GroupLobbyExpiry({ database: storage.sql, appInbox: queue.inbox, groups, nowEpochMs: Date.now,
            serviceId: 'api', retentionMs: 60000 });
        service.listen(queue.outbox);
        queue.inbox.start();
        const due = { kind: 'room' as const, generation: 3, roomRef, groupCreatedAtEpochMs: now - 10000, activationId: 'current', dueAtEpochMs: now - 200 };
        const resilience = createAppInboxTestResilience(0);
        for (const stale of [{ ...due, dueAtEpochMs: now - 300 }, { ...due, activationId: 'old' }]) {
            expect((await service.expire.enqueue({ command: stale, traceId: 'superseded' })).right).toBeDefined();
            await queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience);
            expect((await groups.findGroupLobbyEntry(roomRef))?.value).toEqual(lobby);
        }
        expect((await service.expire.enqueue({ command: due, traceId: 'expire' })).right).toBeDefined();
        await queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience);
        expect(await groups.findGroupLobbyEntry(roomRef)).toBeUndefined();
        expect((await groups.findLobbyCommitmentEntry(scope, 'alice'))?.value.seat).toEqual(newSeat);
        const notices = await storage.sql<readonly { notices: number }[]>`select count(*)::int as notices from resource_inbox where ri_topic_id = 'view.invalidated'`;
        expect(notices[0]?.notices).toBe(1);
    }
    finally {
        await storage.close();
    }
});

it('promotes the next eligible waiter when an unattended offer expires and privately persists the new offer', async () => {
    const storage = await createResourceInboxTestStorage('lobby_offer_expiry');
    try {
        const now = Date.now();
        let authorityNow = now;
        const roomRef = { applicationId: 'game', workspaceId: 'default', groupId: 'court' };
        const scope = { applicationId: roomRef.applicationId, workspaceId: roomRef.workspaceId };
        const runtime = new PSqlRuntimeStateRepository(storage.sql);
        const groups = new GroupStateRepository(runtime, new PSqlGroupStateEventRepository(storage.sql));
        const group = createTestGroup({ ...roomRef, maxMembers: 1 });
        await groups.putGroup(group);
        const due = { generation: 2, dueAtEpochMs: now - 1000 };
        const capacityClaims = { principalIds: ['alice'], generation: 1, dueAtEpochMs: now + 2000 };
        const lobby: RoomLobby = { capacityClaims,
            roomRef, capacity: 1, activationId: 'lobby', expiresAtEpochMs: null, revision: 4,
            policy: { returnWindowMs: 5000, claimWindowMs: 1000 },
            seats: [{ principalId: 'alice', present: false, admissionWindow: null, returnWindow: null, offerWindow: due }],
            waiters: [
                { principalId: 'bob', generation: 3, eligibleUntilEpochMs: now - 10 },
                { principalId: 'carol', generation: 4, eligibleUntilEpochMs: now + 2800 }
            ]
        };
        await runtime.upsert({ namespace: GROUP_LOBBIES_NAMESPACE, key: groupStateGroupStorageKey(roomRef),
            value: JSON.stringify(lobby), expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP });
        for (const principalId of ['alice', 'bob', 'carol']) {
            const seat = { roomRef, status: principalId === 'alice' ? 'offered' : 'waiting',
                deadlineEpochMs: principalId === 'alice' ? due.dueAtEpochMs : null };
            await runtime.upsert({ namespace: GROUP_LOBBY_COMMITMENTS_NAMESPACE, key: lobbyCommitmentKey(scope, principalId),
                value: JSON.stringify({ scope, principalId, seat }), expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP });
        }
        const queue = createSqlServerAppInbox({ database: storage.sql, nowEpochMs: () => authorityNow });
        const service = new GroupLobbyExpiry({ database: storage.sql, appInbox: queue.inbox, groups, nowEpochMs: () => authorityNow,
            serviceId: 'api', retentionMs: 60000 });
        service.listen(queue.outbox);
        queue.inbox.start();
        const command = { kind: 'seat' as const, roomRef, groupCreatedAtEpochMs: group.created.atEpochMs, activationId: 'lobby', ...due };
        expect((await service.expire.enqueue({ command, traceId: 'expiry' })).right).toBeDefined();
        await queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
        expect(await groups.findLobbyCommitmentEntry(scope, 'alice')).toBeUndefined();
        expect(await groups.findLobbyCommitmentEntry(scope, 'bob')).toBeUndefined();
        expect((await groups.findLobbyCommitmentEntry(scope, 'carol'))?.value.seat?.status).toBe('waiting');
        // Alice's separate scheduled reservation still occupies the only place through its no-show boundary.
        authorityNow = capacityClaims.dueAtEpochMs;
        const noShow = { ...command, generation: capacityClaims.generation, dueAtEpochMs: capacityClaims.dueAtEpochMs };
        expect((await service.expire.enqueue({ command: noShow, traceId: 'no-show' })).right).toBeDefined();
        await queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
        expect((await groups.findLobbyCommitmentEntry(scope, 'carol'))?.value.seat).toEqual({
            roomRef, status: 'offered', deadlineEpochMs: now + 2800
        });
        expect((await groups.findGroupLobbyEntry(roomRef))?.value.waiters).toEqual([]);
        expect((await service.expire.submit({ command, traceId: 'replay' })).right).toEqual(command);
        const notifications = await storage.sql<readonly { count: number }[]>`
            select count(*)::int as count from resource_inbox where ri_topic_id = 'view.invalidated'`;
        expect(notifications[0]?.count).toBe(3);
        const timers = await storage.sql<readonly { count: number }[]>`
            select count(*)::int as count from resource_inbox where ri_topic_id = 'room-lobby.deadline'`;
        expect(timers[0]?.count).toBe(1);
    }
    finally {
        await storage.close();
    }
});
