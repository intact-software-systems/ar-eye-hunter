import { describe, expect, it } from 'vitest';
import { EntityStatus, InMemoryQueueBox } from '@shared/mod.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import {
    COALESCED_APP_INBOX_WORK_FIELD,
    CoalescedAppInboxWorkService,
    type CoalescedAppInboxWorkData,
} from '@shared-server/rallar-system/services/CoalescedAppInboxWorkService.ts';
import { AppInboxType } from '@shared-server/rallar-system/services/AppInboxService.ts';

type TestWork = Readonly<{
    overlayId: string;
}>;

describe('CoalescedAppInboxWorkService', () => {
    it('fits scoped RTC topology work keys into the durable app-inbox columns', async () => {
        const queue = new InMemoryQueueBox();
        const reader = new InboxQueueReader(queue);
        const serviceId = 'rallar-server-instance-with-a-long-identity';
        const service = new CoalescedAppInboxWorkService(
            reader,
            serviceId,
            () => 500,
        );
        const groupId =
            'rallar-bb-group-chromium-w0-configured-live-distributed-run-1234567890';
        const overlayId = JSON.stringify([
            'rallar-server',
            'default',
            groupId,
        ]);
        const contextId = `rallar-server:default:${groupId}`;
        const input = {
            type: AppInboxType.RTC_TOPOLOGY_RECOMPUTE,
            topicId: 'app-inbox.rtc-topology',
            resourceId: overlayId,
            contextId,
            data: { overlayId },
        } as const;

        const result = await service.enqueue<TestWork>(input);

        expect(result.entry.key.topicId.length).toBeLessThanOrEqual(36);
        expect(result.entry.key.resourceId.length).toBeLessThanOrEqual(36);
        expect(result.entry.key.contextId.length).toBeLessThanOrEqual(35);
        expect(result.entry.audit.createdBy.length).toBeLessThanOrEqual(16);
        expect(service.toKey(input)).toEqual(result.entry.key);
        expect(result.envelope).toMatchObject({
            topicId: input.topicId,
            resourceId: overlayId,
            contextId,
            senderId: serviceId,
            data: { overlayId },
        });
    });

    it('coalesces repeated work onto one active keyed app-inbox row', async () => {
        let now = 1_000;
        const queue = new InMemoryQueueBox();
        const reader = new InboxQueueReader(queue);
        const service = new CoalescedAppInboxWorkService(
            reader,
            'server-1',
            () => now,
        );

        const first = await service.enqueue<TestWork>({
            type: AppInboxType.RTC_TOPOLOGY_RECOMPUTE,
            topicId: 'app-inbox.rtc-topology',
            resourceId: 'overlay-1',
            contextId: 'room-1',
            data: {
                overlayId: 'overlay-1',
            },
            reason: 'rtt',
            dueAtEpochMs: 1_250,
            merge: mergeReasonsAndUseLatestDueAt,
        });
        now = 1_050;
        const second = await service.enqueue<TestWork>({
            type: AppInboxType.RTC_TOPOLOGY_RECOMPUTE,
            topicId: 'app-inbox.rtc-topology',
            resourceId: 'overlay-1',
            contextId: 'room-1',
            data: {
                overlayId: 'overlay-1',
            },
            reason: 'rtt',
            dueAtEpochMs: 1_300,
            merge: mergeReasonsAndUseLatestDueAt,
        });

        expect(first.action).toBe('inserted');
        expect(first.entry.status).toBe(EntityStatus.RETRY);
        expect(first.entry.dequeueAudit.nextTs?.epochMilliseconds).toBe(1_250);
        expect(second.action).toBe('updated');
        expect(second.previous?.status).toBe(EntityStatus.RETRY);
        expect(second.entry.status).toBe(EntityStatus.RETRY);
        expect(second.entry.dequeueAudit.nextTs?.epochMilliseconds).toBe(1_300);
        expect(
            second.envelope.data[COALESCED_APP_INBOX_WORK_FIELD],
        ).toMatchObject({
            generation: 2,
            dueAtEpochMs: 1_300,
            reasons: ['rtt', 'rtt'],
        });
    });

    it('reopens completed work rows for later coalesced work', async () => {
        const queue = new InMemoryQueueBox();
        const reader = new InboxQueueReader(queue);
        const service = new CoalescedAppInboxWorkService(
            reader,
            'server-1',
            () => 2_000,
        );

        const first = await service.enqueue<TestWork>({
            type: AppInboxType.RTC_TOPOLOGY_RECOMPUTE,
            topicId: 'app-inbox.rtc-topology',
            resourceId: 'overlay-1',
            contextId: 'room-1',
            data: {
                overlayId: 'overlay-1',
            },
        });
        await queue.releaseEntries([first.entry], EntityStatus.COMPLETED);

        const reopened = await service.enqueue<TestWork>({
            type: AppInboxType.RTC_TOPOLOGY_RECOMPUTE,
            topicId: 'app-inbox.rtc-topology',
            resourceId: 'overlay-1',
            contextId: 'room-1',
            data: {
                overlayId: 'overlay-1',
            },
        });

        expect(reopened.action).toBe('updated');
        expect(reopened.previous?.status).toBe(EntityStatus.COMPLETED);
        expect(reopened.entry.status).toBe(EntityStatus.NEW);
        expect(
            reopened.envelope.data[COALESCED_APP_INBOX_WORK_FIELD].generation,
        ).toBe(2);
    });

    it('preserves reserved status while merging newer work and keeps it after release', async () => {
        const queue = new InMemoryQueueBox();
        const reader = new InboxQueueReader(queue);
        const service = new CoalescedAppInboxWorkService(
            reader,
            'server-1',
            () => 3_000,
        );
        await service.enqueue<TestWork>({
            type: AppInboxType.RTC_TOPOLOGY_RECOMPUTE,
            topicId: 'app-inbox.rtc-topology',
            resourceId: 'overlay-1',
            contextId: 'room-1',
            data: {
                overlayId: 'overlay-1',
            },
        });

        const reserved = await queue.reserveEntries(
            new Set([InboxQueueReader.INBOX_ENQUEUE_TYPE]),
            new Set([EntityStatus.NEW]),
            1,
        );
        const reservedEntry = [...reserved.values()][0];

        const coalesced = await service.enqueue<TestWork>({
            type: AppInboxType.RTC_TOPOLOGY_RECOMPUTE,
            topicId: 'app-inbox.rtc-topology',
            resourceId: 'overlay-1',
            contextId: 'room-1',
            data: {
                overlayId: 'overlay-1',
            },
        });

        expect(coalesced.entry.status).toBe(EntityStatus.RESERVED);
        expect(await service.isReservedEntryStale(reservedEntry)).toBe(true);

        await queue.releaseEntries([reservedEntry], EntityStatus.RETRY);

        const stored = await queue.getItem(reservedEntry.key);
        expect(stored?.status).toBe(EntityStatus.RETRY);
        expect(
            service.readEnvelope<TestWork>(stored!).data[
                COALESCED_APP_INBOX_WORK_FIELD
            ].generation,
        ).toBe(2);
    });
});

function mergeReasonsAndUseLatestDueAt<T extends TestWork>(
    existing: CoalescedAppInboxWorkData<T>,
    incoming: CoalescedAppInboxWorkData<T>,
): CoalescedAppInboxWorkData<T> {
    const previous = existing[COALESCED_APP_INBOX_WORK_FIELD];
    const next = incoming[COALESCED_APP_INBOX_WORK_FIELD];

    return {
        ...incoming,
        [COALESCED_APP_INBOX_WORK_FIELD]: {
            ...next,
            dueAtEpochMs: Math.max(previous.dueAtEpochMs, next.dueAtEpochMs),
            reasons: [...previous.reasons, ...next.reasons],
        },
    };
}
