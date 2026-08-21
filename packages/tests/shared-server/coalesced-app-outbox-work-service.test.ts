import { AppOutboxType } from '@shared-server/rallar-system/services/AppOutboxService.ts';
import {
    COALESCED_APP_OUTBOX_WORK_FIELD,
    CoalescedAppOutboxWorkService,
    type CoalescedAppOutboxWorkData
} from '@shared-server/rallar-system/services/CoalescedAppOutboxWorkService.ts';
import { EnqueuedType, EntityStatus, InMemoryQueueBox } from '@shared/mod.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import { describe, expect, it } from 'vitest';

type TestWork = Readonly<{
    overlayId: string;
    snapshotVersion: number;
}>;

describe('CoalescedAppOutboxWorkService', () => {
    it('writes durable coalesced work to APP_OUTBOX', async () => {
        const queue = new InMemoryQueueBox();
        const service = new CoalescedAppOutboxWorkService(
            new OutboxQueueReader(queue),
            'server-1',
            () => 500
        );

        const result = await service.enqueue<TestWork>({
            type: AppOutboxType.RTC_TOPOLOGY_RECOMPUTE,
            topicId: 'app-outbox.rtc-topology',
            resourceId: 'overlay-1',
            contextId: 'room-1',
            data: { overlayId: 'overlay-1', snapshotVersion: 1 }
        });

        expect(result.entry.typeId).toBe(EnqueuedType.APP_OUTBOX);
        expect(result.entry.status).toBe(EntityStatus.NEW);
        expect(result.envelope.data[COALESCED_APP_OUTBOX_WORK_FIELD])
            .toMatchObject({ generation: 1, dueAtEpochMs: 500 });
    });

    it('coalesces versions and reasons onto one APP_OUTBOX row', async () => {
        let now = 1_000;
        const queue = new InMemoryQueueBox();
        const service = new CoalescedAppOutboxWorkService(
            new OutboxQueueReader(queue),
            'server-1',
            () => now
        );
        const input = {
            type: AppOutboxType.RTC_TOPOLOGY_RECOMPUTE,
            topicId: 'app-outbox.rtc-topology',
            resourceId: 'overlay-1',
            contextId: 'room-1'
        } as const;

        await service.enqueue<TestWork>({
            ...input,
            data: { overlayId: 'overlay-1', snapshotVersion: 1 },
            reason: 'group-snapshot',
            merge: mergeVersionsAndReasons
        });
        now = 1_100;
        const updated = await service.enqueue<TestWork>({
            ...input,
            data: { overlayId: 'overlay-1', snapshotVersion: 3 },
            reason: 'rtt',
            merge: mergeVersionsAndReasons
        });

        expect(updated.action).toBe('updated');
        expect(updated.envelope.data.snapshotVersion).toBe(3);
        expect(updated.envelope.data[COALESCED_APP_OUTBOX_WORK_FIELD])
            .toMatchObject({
                generation: 2,
                reasons: ['group-snapshot', 'rtt']
            });
    });

    it('keeps a reserved generation immutable when newer work arrives', async () => {
        const queue = new InMemoryQueueBox();
        const service = new CoalescedAppOutboxWorkService(
            new OutboxQueueReader(queue),
            'server-1',
            () => 2_000
        );
        await service.enqueue<TestWork>({
            type: AppOutboxType.RTC_TOPOLOGY_RECOMPUTE,
            topicId: 'app-outbox.rtc-topology',
            resourceId: 'overlay-1',
            contextId: 'room-1',
            data: { overlayId: 'overlay-1', snapshotVersion: 1 }
        });
        const reserved = await queue.reserveEntries(
            OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
            new Set([EntityStatus.NEW]),
            1
        );
        const reservedEntry = [...reserved.values()][0]!;

        const successor = await service.enqueue<TestWork>({
            type: AppOutboxType.RTC_TOPOLOGY_RECOMPUTE,
            topicId: 'app-outbox.rtc-topology',
            resourceId: 'overlay-1',
            contextId: 'room-1',
            data: { overlayId: 'overlay-1', snapshotVersion: 2 }
        });

        expect(successor.blockedByReserved).toBe(true);
        expect(successor.entry).toEqual(reservedEntry);
        expect(successor.envelope.data.snapshotVersion).toBe(1);
        expect(successor.envelope.data[COALESCED_APP_OUTBOX_WORK_FIELD])
            .toMatchObject({ generation: 1 });
        expect(await service.isReservedEntryStale(reservedEntry)).toBe(false);
    });
});

function mergeVersionsAndReasons(
    existing: CoalescedAppOutboxWorkData<TestWork>,
    incoming: CoalescedAppOutboxWorkData<TestWork>
): CoalescedAppOutboxWorkData<TestWork> {
    const previous = existing[COALESCED_APP_OUTBOX_WORK_FIELD];
    const next = incoming[COALESCED_APP_OUTBOX_WORK_FIELD];
    return {
        ...incoming,
        snapshotVersion: Math.max(
            existing.snapshotVersion,
            incoming.snapshotVersion
        ),
        [COALESCED_APP_OUTBOX_WORK_FIELD]: {
            ...next,
            reasons: [...previous.reasons, ...next.reasons]
        }
    };
}
