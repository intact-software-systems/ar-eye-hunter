import assert from 'node:assert/strict';

import type {
  RtcTopologyDeliveryStreamMaintenancePort,
  RtcTopologyDeliveryStreamScheduler,
} from '@shared-server/rallar-system/topology/replay/rtc-topology-delivery-stream-service.ts';
import { RtcTopologyDeliveryLeaseLostError } from '@shared-server/rallar-system/topology/replay/rtc-topology-delivery-stream-service.ts';
import { startApiRtcTopologyDelivery } from '../../src/runtime/rtc-topology/rtc-topology-delivery-startup.ts';

const STREAM_ID = '00000000-0000-4000-8000-000000000001';

Deno.test('API topology delivery startup rejects stream identity collision before readiness', async () => {
  const scheduled: number[] = [];
  const lifecycle = startApiRtcTopologyDelivery({
    streamId: STREAM_ID,
    repository: repository({ register: 'conflict' }),
    scheduler: scheduler(scheduled),
  });

  await assert.rejects(lifecycle.readiness, RtcTopologyDeliveryLeaseLostError);
  assert.deepEqual(scheduled, []);
  lifecycle.stop();
});

Deno.test('API topology delivery startup exposes typed post-readiness lease loss', async () => {
  const tasks = new Map<number, () => Promise<void>>();
  const lifecycle = startApiRtcTopologyDelivery({
    streamId: STREAM_ID,
    repository: repository({ renewal: 'lease-lost' }),
    scheduler: {
      repeat: (task, intervalMs) => {
        tasks.set(intervalMs, task);
        return () => {
          tasks.delete(intervalMs);
        };
      },
    },
  });
  await lifecycle.readiness;

  await tasks.get(10_000)?.();

  await assert.rejects(lifecycle.healthFailure, RtcTopologyDeliveryLeaseLostError);
  assert.equal(tasks.size, 0);
  lifecycle.stop();
});

function repository(
  options: Readonly<{
    register?: 'registered' | 'conflict';
    renewal?: 'renewed' | 'lease-lost';
  }> = {},
): RtcTopologyDeliveryStreamMaintenancePort {
  return {
    registerStream: async () =>
      options.register === 'conflict' ? { status: 'conflict' } : {
        status: 'registered',
        stream: {
          streamId: STREAM_ID,
          headSequence: 0,
          retainedFromSequence: 1,
          leaseExpiresAtEpochMs: 30_000,
        },
      },
    renewStreamLease: async () =>
      options.renewal === 'lease-lost' ? { status: 'lease-lost' } : {
        status: 'renewed',
        stream: {
          streamId: STREAM_ID,
          headSequence: 0,
          retainedFromSequence: 1,
          leaseExpiresAtEpochMs: 40_000,
        },
      },
    compactExpiredEntries: async () => ({
      scannedStreamCount: 1,
      deletedEntryCount: 0,
    }),
  };
}

function scheduler(scheduled: number[]): RtcTopologyDeliveryStreamScheduler {
  return {
    repeat: (_task, intervalMs) => {
      scheduled.push(intervalMs);
      return () => undefined;
    },
  };
}
