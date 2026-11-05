import { computeGroupSessionDeadlines, decodeGroupSessionDeadline } from '@shared-server/rallar-system/group-state/schedule/group-session-deadline.ts';
import { expect, it, vi } from 'vitest';
import { createTestGroup } from '../../../create-test-group.ts';

it('persists each future canonical phase boundary once and suppresses unchanged or cancelled schedules', () => {
    const group = createTestGroup({ metadata: { rallarSessionSchedule: { revision: 1, startsAtEpochMs: 2000000, cancelledAtEpochMs: null } } });
    const input = {
        changedMembers: [],
        previousMembers: [],
        before: null,
        after: group,
        createdAtEpochMs: 1000000,
        retentionMs: 60000,
        serviceId: 'test',
        traceId: 'trace'
    };
    const rows = computeGroupSessionDeadlines(input);
    expect(rows.map((row) => Number(row.entry.dequeueAudit.nextTs!.epochMilliseconds))).toEqual([1400000, 2000000, 2600000]);
    expect(computeGroupSessionDeadlines({ ...input, before: group })).toEqual([]);
    expect(
        computeGroupSessionDeadlines({
            ...input,
            after: { ...group, metadata: { rallarSessionSchedule: { revision: 2, startsAtEpochMs: 2000000, cancelledAtEpochMs: 1000000 } } }
        })
    ).toEqual([]);
    const deadline = decodeGroupSessionDeadline(JSON.parse(JSON.parse(rows[0].entry.resource).payload.resource));
    expect(() => decodeGroupSessionDeadline({ ...deadline, dueAtEpochMs: deadline.dueAtEpochMs + 1 })).toThrow();
});

import { writeGroupSessionDeadline } from '@shared-server/rallar-system/group-state/schedule/group-session-deadline-service.ts';
import type { GroupSessionDeadline } from '@shared-server/rallar-system/group-state/schedule/group-session-deadline.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { decodePersistedALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { decodeViewInvalidationMessage } from '@shared/api/views/view-invalidation.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { createResourceInboxTestStorage, type ResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';
import { createAppInboxTestResilience } from '../app-inbox/test-support/app-inbox-resource-fixtures.ts';
import { createViewWatchTestRuntime, ref, viewWatchCommand, type ViewWatchTestRuntime } from './view-watch-test-runtime.ts';

it('publishes a durable phase wake to the current preview visitor, with replay and no gameplay mutation', async () => {
    const storage = await createResourceInboxTestStorage('session_deadline_delivery');
    try {
        const test = await createViewWatchTestRuntime(storage);
        const deadline = await dueDeadline(test);
        await test.run(viewWatchCommand(test, 'watch', null));
        const before = (await test.party.groups.findGroupEntry(ref))!;
        await runDeadline(test, deadline);
        expect((await notices(storage)).map((notice) => notice.principalId).sort()).toEqual([before.value.ownerPrincipalId, 'bob'].sort());
        expect((await test.party.groups.findGroupEntry(ref))!.value).toEqual(before.value);
        const count = (await notices(storage)).length;
        await runDeadline(test, deadline);
        expect(await notices(storage)).toHaveLength(count);
    }
    finally {
        await storage.close();
    }
});

it('retries an audience captured before registration and drops cancelled or rescheduled wakes', async () => {
    const storage = await createResourceInboxTestStorage('session_deadline_race');
    try {
        const test = await createViewWatchTestRuntime(storage);
        const deadline = await dueDeadline(test);
        const stale = test.deadlines.compute(await test.deadlines.read(deadline, 'test'));
        await test.run(viewWatchCommand(test, 'watch', null));
        await expect(storage.sql.begin((transaction) => writeGroupSessionDeadline(transaction, stale))).rejects.toBeInstanceOf(
            RuntimeStateWriteConflictError
        );
        expect(await notices(storage)).toEqual([]);
        await runDeadline(test, deadline);
        expect((await notices(storage)).some((notice) => notice.principalId === 'bob')).toBe(true);
        const group = (await test.party.groups.findGroupEntry(ref))!;
        await test.party.groups.updateGroup({
            ...group.value,
            metadata: {
                ...group.value.metadata,
                rallarSessionSchedule: {
                    revision: 2,
                    startsAtEpochMs: deadline.startsAtEpochMs + 1000,
                    cancelledAtEpochMs: null
                }
            }
        }, group.entry.revision);
        expect(test.deadlines.compute(await test.deadlines.read(deadline, 'test'))).toBeNull();
        const current = (await test.party.groups.findGroupEntry(ref))!;
        await test.party.groups.updateGroup({
            ...current.value,
            metadata: {
                ...current.value.metadata,
                rallarSessionSchedule: {
                    revision: deadline.scheduleRevision,
                    startsAtEpochMs: deadline.startsAtEpochMs,
                    cancelledAtEpochMs: test.party.clock.now
                }
            }
        }, current.entry.revision);
        expect(test.deadlines.compute(await test.deadlines.read(deadline, 'test'))).toBeNull();
    }
    finally {
        await storage.close();
    }
});

it('rolls back the deadline provenance, leaving the observed group row unwritten, when its final notice insert fails', async () => {
    const storage = await createResourceInboxTestStorage('session_deadline_rollback');
    try {
        const test = await createViewWatchTestRuntime(storage);
        const deadline = await dueDeadline(test);
        await test.run(viewWatchCommand(test, 'watch', null));
        const before = await test.party.groups.findGroupEntry(ref);
        const write = test.deadlines.compute(await test.deadlines.read(deadline, 'test'));
        const rows = await storage.sql`select count(*)::text as count from runtime_state_store`;
        await storage.sql`create function reject_deadline_notice() returns trigger language plpgsql as 'begin return null; end'`;
        await storage.sql`create trigger reject_deadline_notice before insert on resource_inbox for each row execute function reject_deadline_notice()`;
        await expect(storage.sql.begin((transaction) => writeGroupSessionDeadline(transaction, write))).rejects.toThrow();
        expect(await test.party.groups.findGroupEntry(ref)).toEqual(before);
        expect(await storage.sql`select count(*)::text as count from runtime_state_store`).toEqual(rows);
        expect(await notices(storage)).toEqual([]);
    }
    finally {
        await storage.close();
    }
});

async function dueDeadline(test: ViewWatchTestRuntime): Promise<GroupSessionDeadline.Phase> {
    const group = (await test.party.groups.findGroupEntry(ref))!;
    await test.party.groups.updateGroup({
        ...group.value,
        metadata: {
            ...group.value.metadata,
            rallarSessionSchedule: {
                revision: 1,
                startsAtEpochMs: test.party.clock.now,
                cancelledAtEpochMs: null
            }
        }
    }, group.entry.revision);
    return {
        ref,
        kind: 'start',
        groupCreatedAtEpochMs: group.value.created.atEpochMs,
        scheduleRevision: 1,
        startsAtEpochMs: test.party.clock.now,
        dueAtEpochMs: test.party.clock.now
    };
}

async function runDeadline(test: ViewWatchTestRuntime, command: GroupSessionDeadline): Promise<void> {
    const admission = await test.deadlines.wake.enqueue({ command, traceId: 'deadline-test' });
    await test.party.queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
    const result = await admission.right!.wait();
    if (result.left !== undefined) {
        throw result.left;
    }
}

async function notices(storage: ResourceInboxTestStorage) {
    const rows = await storage.sql<
        readonly { ri_resource: string; }[]
    >`select ri_resource from resource_inbox where ri_topic_id = 'view.invalidated' order by ri_resource_id`;
    return rows.map((row) => decodeViewInvalidationMessage(decodePersistedALMessageValue(JSON.parse(row.ri_resource))));
}

import { writeAppOutboxInserts } from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import { installGroupSessionDeadline } from '@shared-server/rallar-system/group-state/schedule/install-group-session-deadline.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

it('delivers the stored future wake through the real outbox and AppInbox only when due', async () => {
    const storage = await createResourceInboxTestStorage('session_deadline_queue');
    try {
        const test = await createViewWatchTestRuntime(storage);
        const current = (await test.party.groups.findGroupEntry(ref))!;
        const group = {
            ...current.value,
            metadata: {
                ...current.value.metadata,
                rallarSessionSchedule: {
                    revision: 2,
                    startsAtEpochMs: test.party.clock.now + 1000,
                    cancelledAtEpochMs: null
                }
            }
        };
        await test.party.groups.updateGroup(group, current.entry.revision);
        await test.run(viewWatchCommand(test, 'watch', null));
        const rows = computeGroupSessionDeadlines({
            changedMembers: [],
            previousMembers: [],
            before: current.value,
            after: group,
            createdAtEpochMs: test.party.clock.now,
            retentionMs: 60000,
            serviceId: 'test',
            traceId: 'trace'
        });
        await storage.sql.begin((transaction) => writeAppOutboxInserts(transaction, rows));
        installGroupSessionDeadline({
            outboxQueueReader: test.party.queue.outbox,
            nowEpochMs: () => test.party.clock.now,
            enqueue: async (command, traceId) => {
                const admission = await test.deadlines.wake.enqueue({ command, traceId });
                if (admission.left !== undefined) {
                    throw new Error(admission.left.message);
                }
            }
        });
        expect(await test.party.queue.outbox.dequeueOutbox(OutboxQueueReader.OUTBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0))).toBe(0);
        await vi.waitFor(async () => {
            test.party.clock.now = Date.now();
            expect(await test.party.queue.outbox.dequeueOutbox(OutboxQueueReader.OUTBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0))).toBe(1);
        }, { timeout: 3000, interval: 20 });
        await test.party.queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
        expect((await notices(storage)).some((notice) => notice.principalId === 'bob')).toBe(true);
    }
    finally {
        await storage.close();
    }
});

it('rejects forged deadline guards, proof effects, outbox content, and captured group scope before commit', async () => {
    const storage = await createResourceInboxTestStorage('session_deadline_validation');
    try {
        const test = await createViewWatchTestRuntime(storage);
        const deadline = await dueDeadline(test);
        await test.run(viewWatchCommand(test, 'watch', null));
        const read = await test.deadlines.read(deadline, 'test');
        const computed = test.deadlines.compute(read)!;
        expect(test.deadlines.validate(read, computed)).toEqual([]);
        const { publication } = computed;
        if ('operation' in publication.storage) {
            throw new Error('Expected owner notice provenance batch');
        }
        const forge = (forged: Partial<typeof publication>) => ({ ...computed, publication: { ...publication, ...forged } });
        expect(test.deadlines.validate(read, forge({ outbox: [] }))).not.toEqual([]);
        expect(test.deadlines.validate(read, forge({ storage: { ...publication.storage, effects: [] } }))).not.toEqual([]);
        expect(test.deadlines.validate(read, forge({ storage: { ...publication.storage, guard: { ...publication.storage.guard, key: 'another-room' } } }))).not
            .toEqual([]);
        expect(test.deadlines.validate(read, forge({ outbox: [{ ...publication.outbox[0], entry: { ...publication.outbox[0].entry, resource: '{}' } }] }))).not
            .toEqual([]);
        expect(test.deadlines.validate(read, { ...computed, observations: { ...computed.observations, observationsJson: '[]' } })).not.toEqual([]);
        expect(() => test.deadlines.compute({ ...read, audience: { ref: { ...ref, groupId: 'another-room' }, principalIds: [] } })).toThrow();
        expect(await notices(storage)).toEqual([]);
    }
    finally {
        await storage.close();
    }
});
