import { describe, expect, it } from 'vitest';

import {
    RTC_TOPOLOGY_REPLAY_COMPACTION_INTERVAL_MS,
    RTC_TOPOLOGY_REPLAY_COMPACTION_PAGE_SIZE,
    RTC_TOPOLOGY_REPLAY_HEARTBEAT_INTERVAL_MS,
    RTC_TOPOLOGY_REPLAY_LEASE_DURATION_MS,
    RTC_TOPOLOGY_REPLAY_RETENTION_MS
} from '@shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-policy.ts';
import type { RtcTopologyDeliveryStream } from '@shared-server/rallar-system/topology/replay/delivery/rtc-topology-delivery-contracts.ts';
import {
    RtcTopologyDeliveryLeaseLostError,
    RtcTopologyDeliveryStreamService,
    type RtcTopologyDeliveryStreamMaintenancePort,
    type RtcTopologyDeliveryStreamScheduler
} from '@shared-server/rallar-system/topology/replay/delivery/rtc-topology-delivery-stream-service.ts';

const STREAM_ID = '00000000-0000-4000-8000-000000000001';
const DELIVERY_POLICY = {
    heartbeatIntervalMs: RTC_TOPOLOGY_REPLAY_HEARTBEAT_INTERVAL_MS,
    leaseDurationMs: RTC_TOPOLOGY_REPLAY_LEASE_DURATION_MS,
    compactionIntervalMs: RTC_TOPOLOGY_REPLAY_COMPACTION_INTERVAL_MS,
    compactionPageSize: RTC_TOPOLOGY_REPLAY_COMPACTION_PAGE_SIZE,
    consumerRetentionMs: RTC_TOPOLOGY_REPLAY_RETENTION_MS
} as const;

interface DeliveryRepositoryCalls {
    readonly registerStream: Array<Parameters<RtcTopologyDeliveryStreamMaintenancePort['registerStream']>[0]>;
    readonly renewStreamLease: Array<Parameters<RtcTopologyDeliveryStreamMaintenancePort['renewStreamLease']>[0]>;
    readonly compactExpiredEntries: Array<Parameters<RtcTopologyDeliveryStreamMaintenancePort['compactExpiredEntries']>[0]>;
    readonly retireExpiredConsumerCursors: Array<Parameters<RtcTopologyDeliveryStreamMaintenancePort['retireExpiredConsumerCursors']>[0]>;
    readonly retireEmptyStreams: Array<Parameters<RtcTopologyDeliveryStreamMaintenancePort['retireEmptyStreams']>[0]>;
}

interface RecordingDeliveryRepository extends RtcTopologyDeliveryStreamMaintenancePort {
    readonly calls: DeliveryRepositoryCalls;
}

describe('RTC topology delivery stream service', () => {
    it('registers before scheduling database-time heartbeat and bounded compaction', async () => {
        const events: string[] = [];
        const repository = createRepository({
            registerStream: async () => {
                events.push('registered');
                return { status: 'registered', stream: registeredStream() };
            }
        });
        const scheduler = createScheduler(events);
        const service = new RtcTopologyDeliveryStreamService({
            streamId: STREAM_ID,
            repository,
            policy: DELIVERY_POLICY,
            scheduler,
            onHealthFailure: () => undefined
        });

        await service.start();

        expect(repository.calls.registerStream).toEqual([
            {
                streamId: STREAM_ID,
                leaseDurationMs: RTC_TOPOLOGY_REPLAY_LEASE_DURATION_MS
            }
        ]);
        expect(events).toEqual([
            'registered',
            `scheduled:${RTC_TOPOLOGY_REPLAY_HEARTBEAT_INTERVAL_MS}`,
            `scheduled:${RTC_TOPOLOGY_REPLAY_COMPACTION_INTERVAL_MS}`
        ]);

        await scheduler.run(RTC_TOPOLOGY_REPLAY_HEARTBEAT_INTERVAL_MS);
        await scheduler.run(RTC_TOPOLOGY_REPLAY_COMPACTION_INTERVAL_MS);

        expect(repository.calls.renewStreamLease).toEqual([
            {
                streamId: STREAM_ID,
                leaseDurationMs: RTC_TOPOLOGY_REPLAY_LEASE_DURATION_MS
            }
        ]);
        expect(repository.calls.compactExpiredEntries).toEqual([
            { pageSize: RTC_TOPOLOGY_REPLAY_COMPACTION_PAGE_SIZE }
        ]);
        expect(repository.calls.retireExpiredConsumerCursors).toEqual([
            {
                retentionMs: RTC_TOPOLOGY_REPLAY_RETENTION_MS,
                pageSize: RTC_TOPOLOGY_REPLAY_COMPACTION_PAGE_SIZE
            }
        ]);
        expect(repository.calls.retireEmptyStreams).toEqual([
            { pageSize: RTC_TOPOLOGY_REPLAY_COMPACTION_PAGE_SIZE }
        ]);
    });

    it('fails readiness when the process stream identity is already owned', async () => {
        const scheduler = createScheduler([]);
        const repository = createRepository({
            registerStream: async () => ({ status: 'conflict' })
        });
        const healthFailures: Error[] = [];
        const service = new RtcTopologyDeliveryStreamService({
            streamId: STREAM_ID,
            repository,
            policy: DELIVERY_POLICY,
            scheduler,
            onHealthFailure: (error) => healthFailures.push(error)
        });

        await expect(service.start()).rejects.toBeInstanceOf(RtcTopologyDeliveryLeaseLostError);
        expect(scheduler.scheduledIntervals()).toEqual([]);
        expect(healthFailures).toEqual([]);
    });

    it('stops both loops and reports typed health failure after lease loss', async () => {
        const events: string[] = [];
        const scheduler = createScheduler(events);
        const repository = createRepository({
            renewStreamLease: async () => ({ status: 'lease-lost' })
        });
        const healthFailures: Error[] = [];
        const service = new RtcTopologyDeliveryStreamService({
            streamId: STREAM_ID,
            repository,
            policy: DELIVERY_POLICY,
            scheduler,
            onHealthFailure: (error) => healthFailures.push(error)
        });
        await service.start();

        await scheduler.run(RTC_TOPOLOGY_REPLAY_HEARTBEAT_INTERVAL_MS);

        expect(healthFailures).toHaveLength(1);
        expect(healthFailures[0]).toBeInstanceOf(RtcTopologyDeliveryLeaseLostError);
        expect(scheduler.cancelledIntervals()).toEqual([
            RTC_TOPOLOGY_REPLAY_HEARTBEAT_INTERVAL_MS,
            RTC_TOPOLOGY_REPLAY_COMPACTION_INTERVAL_MS
        ]);
        await scheduler.run(RTC_TOPOLOGY_REPLAY_COMPACTION_INTERVAL_MS);
        expect(repository.calls.compactExpiredEntries).toEqual([]);
    });

    it('makes stop idempotent and prevents later scheduled maintenance', async () => {
        const scheduler = createScheduler([]);
        const repository = createRepository();
        const service = new RtcTopologyDeliveryStreamService({
            streamId: STREAM_ID,
            repository,
            policy: DELIVERY_POLICY,
            scheduler,
            onHealthFailure: () => undefined
        });
        await service.start();

        service.stop();
        service.stop();
        await scheduler.run(RTC_TOPOLOGY_REPLAY_HEARTBEAT_INTERVAL_MS);
        await scheduler.run(RTC_TOPOLOGY_REPLAY_COMPACTION_INTERVAL_MS);

        expect(repository.calls.renewStreamLease).toEqual([]);
        expect(repository.calls.compactExpiredEntries).toEqual([]);
    });
});

function createRepository(
    overrides: Partial<RtcTopologyDeliveryStreamMaintenancePort> = {}
): RecordingDeliveryRepository {
    const calls: DeliveryRepositoryCalls = {
        registerStream: [],
        renewStreamLease: [],
        compactExpiredEntries: [],
        retireExpiredConsumerCursors: [],
        retireEmptyStreams: []
    };
    return {
        calls,
        registerStream: async (input) => {
            calls.registerStream.push(input);
            return overrides.registerStream
                ? await overrides.registerStream(input)
                : { status: 'registered', stream: registeredStream() };
        },
        renewStreamLease: async (input) => {
            calls.renewStreamLease.push(input);
            return overrides.renewStreamLease
                ? await overrides.renewStreamLease(input)
                : { status: 'renewed', stream: registeredStream() };
        },
        compactExpiredEntries: async (input) => {
            calls.compactExpiredEntries.push(input);
            return overrides.compactExpiredEntries
                ? await overrides.compactExpiredEntries(input)
                : { scannedStreamCount: 1, deletedEntryCount: 0 };
        },
        retireExpiredConsumerCursors: async (input) => {
            calls.retireExpiredConsumerCursors.push(input);
            return overrides.retireExpiredConsumerCursors
                ? await overrides.retireExpiredConsumerCursors(input)
                : { deletedCursorCount: 0 };
        },
        retireEmptyStreams: async (input) => {
            calls.retireEmptyStreams.push(input);
            return overrides.retireEmptyStreams
                ? await overrides.retireEmptyStreams(input)
                : { deletedStreamCount: 0 };
        }
    };
}

function registeredStream(): RtcTopologyDeliveryStream {
    return {
        streamId: STREAM_ID,
        headSequence: 0,
        retainedFromSequence: 1,
        leaseExpiresAtEpochMs: 31_000
    };
}

function createScheduler(events: string[]): RtcTopologyDeliveryStreamScheduler & {
    run(intervalMs: number): Promise<void>;
    scheduledIntervals(): readonly number[];
    cancelledIntervals(): readonly number[];
} {
    const tasks = new Map<number, () => Promise<void>>();
    const cancelled: number[] = [];
    return {
        repeat: (task, intervalMs) => {
            events.push(`scheduled:${intervalMs}`);
            tasks.set(intervalMs, task);
            return () => {
                if (!tasks.delete(intervalMs)) {
                    return;
                }
                cancelled.push(intervalMs);
            };
        },
        run: async (intervalMs) => {
            await tasks.get(intervalMs)?.();
        },
        scheduledIntervals: () => [...tasks.keys()],
        cancelledIntervals: () => cancelled
    };
}
