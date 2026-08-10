import { describe, expect, it, vi } from 'vitest';

import type {
  RtcTopologyDeliveryCompactionResult,
  RtcTopologyDeliveryStream,
} from '@shared-server/rallar-system/topology/replay/rtc-topology-delivery-contracts.ts';
import {
  RtcTopologyDeliveryLeaseLostError,
  RtcTopologyDeliveryStreamService,
  type RtcTopologyDeliveryStreamMaintenancePort,
  type RtcTopologyDeliveryStreamScheduler,
} from '@shared-server/rallar-system/topology/replay/rtc-topology-delivery-stream-service.ts';
import {
  RTC_TOPOLOGY_REPLAY_COMPACTION_INTERVAL_MS,
  RTC_TOPOLOGY_REPLAY_COMPACTION_PAGE_SIZE,
  RTC_TOPOLOGY_REPLAY_HEARTBEAT_INTERVAL_MS,
  RTC_TOPOLOGY_REPLAY_LEASE_DURATION_MS,
  RTC_TOPOLOGY_REPLAY_RETENTION_MS,
} from '@shared-server/rallar-system/topology/replay/rtc-topology-replay-policy.ts';

const STREAM_ID = '00000000-0000-4000-8000-000000000001';

describe('RTC topology delivery stream service', () => {
  it('registers before scheduling database-time heartbeat and bounded compaction', async () => {
    const events: string[] = [];
    const repository = createRepository({
      registerStream: async () => {
        events.push('registered');
        return { status: 'registered', stream: registeredStream() };
      },
    });
    const scheduler = createScheduler(events);
    const service = new RtcTopologyDeliveryStreamService({
      streamId: STREAM_ID,
      repository,
      scheduler,
      onHealthFailure: vi.fn(),
    });

    await service.start();

    expect(repository.registerStream).toHaveBeenCalledWith({
      streamId: STREAM_ID,
      leaseDurationMs: RTC_TOPOLOGY_REPLAY_LEASE_DURATION_MS,
    });
    expect(events).toEqual([
      'registered',
      `scheduled:${RTC_TOPOLOGY_REPLAY_HEARTBEAT_INTERVAL_MS}`,
      `scheduled:${RTC_TOPOLOGY_REPLAY_COMPACTION_INTERVAL_MS}`,
    ]);

    await scheduler.run(RTC_TOPOLOGY_REPLAY_HEARTBEAT_INTERVAL_MS);
    await scheduler.run(RTC_TOPOLOGY_REPLAY_COMPACTION_INTERVAL_MS);

    expect(repository.renewStreamLease).toHaveBeenCalledWith({
      streamId: STREAM_ID,
      leaseDurationMs: RTC_TOPOLOGY_REPLAY_LEASE_DURATION_MS,
    });
    expect(repository.compactExpiredEntries).toHaveBeenCalledWith({
      pageSize: RTC_TOPOLOGY_REPLAY_COMPACTION_PAGE_SIZE,
    });
    expect(repository.retireExpiredConsumerCursors).toHaveBeenCalledWith({
      retentionMs: RTC_TOPOLOGY_REPLAY_RETENTION_MS,
      pageSize: RTC_TOPOLOGY_REPLAY_COMPACTION_PAGE_SIZE,
    });
    expect(repository.retireEmptyStreams).toHaveBeenCalledWith({
      pageSize: RTC_TOPOLOGY_REPLAY_COMPACTION_PAGE_SIZE,
    });
  });

  it('fails readiness when the process stream identity is already owned', async () => {
    const scheduler = createScheduler([]);
    const repository = createRepository({
      registerStream: async () => ({ status: 'conflict' }),
    });
    const onHealthFailure = vi.fn();
    const service = new RtcTopologyDeliveryStreamService({
      streamId: STREAM_ID,
      repository,
      scheduler,
      onHealthFailure,
    });

    await expect(service.start()).rejects.toBeInstanceOf(RtcTopologyDeliveryLeaseLostError);
    expect(scheduler.scheduledIntervals()).toEqual([]);
    expect(onHealthFailure).not.toHaveBeenCalled();
  });

  it('stops both loops and reports typed health failure after lease loss', async () => {
    const events: string[] = [];
    const scheduler = createScheduler(events);
    const repository = createRepository({
      renewStreamLease: async () => ({ status: 'lease-lost' }),
    });
    const onHealthFailure = vi.fn();
    const service = new RtcTopologyDeliveryStreamService({
      streamId: STREAM_ID,
      repository,
      scheduler,
      onHealthFailure,
    });
    await service.start();

    await scheduler.run(RTC_TOPOLOGY_REPLAY_HEARTBEAT_INTERVAL_MS);

    expect(onHealthFailure).toHaveBeenCalledOnce();
    expect(onHealthFailure.mock.calls[0]![0]).toBeInstanceOf(RtcTopologyDeliveryLeaseLostError);
    expect(scheduler.cancelledIntervals()).toEqual([
      RTC_TOPOLOGY_REPLAY_HEARTBEAT_INTERVAL_MS,
      RTC_TOPOLOGY_REPLAY_COMPACTION_INTERVAL_MS,
    ]);
    await scheduler.run(RTC_TOPOLOGY_REPLAY_COMPACTION_INTERVAL_MS);
    expect(repository.compactExpiredEntries).not.toHaveBeenCalled();
  });

  it('makes stop idempotent and prevents later scheduled maintenance', async () => {
    const scheduler = createScheduler([]);
    const repository = createRepository();
    const service = new RtcTopologyDeliveryStreamService({
      streamId: STREAM_ID,
      repository,
      scheduler,
      onHealthFailure: vi.fn(),
    });
    await service.start();

    service.stop();
    service.stop();
    await scheduler.run(RTC_TOPOLOGY_REPLAY_HEARTBEAT_INTERVAL_MS);
    await scheduler.run(RTC_TOPOLOGY_REPLAY_COMPACTION_INTERVAL_MS);

    expect(repository.renewStreamLease).not.toHaveBeenCalled();
    expect(repository.compactExpiredEntries).not.toHaveBeenCalled();
  });
});

function createRepository(
  overrides: Partial<RtcTopologyDeliveryStreamMaintenancePort> = {},
): RtcTopologyDeliveryStreamMaintenancePort & {
  registerStream: ReturnType<typeof vi.fn>;
  renewStreamLease: ReturnType<typeof vi.fn>;
  compactExpiredEntries: ReturnType<typeof vi.fn>;
  retireExpiredConsumerCursors: ReturnType<typeof vi.fn>;
  retireEmptyStreams: ReturnType<typeof vi.fn>;
} {
  return {
    registerStream: vi.fn(
      overrides.registerStream ??
        (async () => ({
          status: 'registered' as const,
          stream: registeredStream(),
        })),
    ),
    renewStreamLease: vi.fn(
      overrides.renewStreamLease ??
        (async () => ({
          status: 'renewed' as const,
          stream: registeredStream(),
        })),
    ),
    compactExpiredEntries: vi.fn(
      overrides.compactExpiredEntries ??
        (async (): Promise<RtcTopologyDeliveryCompactionResult> => ({
          scannedStreamCount: 1,
          deletedEntryCount: 0,
        })),
    ),
    retireExpiredConsumerCursors: vi.fn(
      overrides.retireExpiredConsumerCursors ??
        (async () => ({ deletedCursorCount: 0 })),
    ),
    retireEmptyStreams: vi.fn(
      overrides.retireEmptyStreams ??
        (async () => ({ deletedStreamCount: 0 })),
    ),
  };
}

function registeredStream(): RtcTopologyDeliveryStream {
  return {
    streamId: STREAM_ID,
    headSequence: 0,
    retainedFromSequence: 1,
    leaseExpiresAtEpochMs: 31_000,
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
        if (!tasks.delete(intervalMs)) return;
        cancelled.push(intervalMs);
      };
    },
    run: async (intervalMs) => {
      await tasks.get(intervalMs)?.();
    },
    scheduledIntervals: () => [...tasks.keys()],
    cancelledIntervals: () => cancelled,
  };
}
