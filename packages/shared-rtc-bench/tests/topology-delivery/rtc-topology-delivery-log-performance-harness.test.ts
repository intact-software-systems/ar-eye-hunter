import { describe, expect, it } from 'vitest';

import {
  RTC_TOPOLOGY_DELIVERY_LOG_BENCHMARK_POLICY,
  summarizeRtcTopologyDeliveryLatencies,
} from '../../topology-delivery/delivery-log-bench.ts';
import { registerRtcTopologyDeliveryBenchmarkStreams } from '../../topology-delivery/run-rtc-topology-delivery-log-workloads.ts';

describe('RTC topology delivery-log performance harness', () => {
  it('keeps the one-stream and three-stream workloads directly comparable', () => {
    expect(RTC_TOPOLOGY_DELIVERY_LOG_BENCHMARK_POLICY).toEqual({
      appendCount: 300,
      concurrency: 10,
      duplicateRaceCount: 30,
      rollbackCount: 100,
      leaseDurationMs: 120_000,
      retentionMs: 3_600_000,
    });
  });

  it('reports deterministic nearest-rank p50, p95, and p99 latency', () => {
    expect(summarizeRtcTopologyDeliveryLatencies([1, 2, 3, 4, 5])).toEqual({
      p50: 3,
      p95: 5,
      p99: 5,
    });
    expect(() => summarizeRtcTopologyDeliveryLatencies([])).toThrow(
      'RTC topology delivery benchmark latency samples are required',
    );
  });

  it('cleans only benchmark-owned streams when registration fails partway', async () => {
    const cleaned: string[][] = [];
    await expect(
      registerRtcTopologyDeliveryBenchmarkStreams({
        streams: ['owned-1', 'collision', 'never-attempted'],
        register: async (streamId) => (streamId === 'collision' ? 'collision' : 'registered'),
        cleanup: async (streams) => {
          cleaned.push([...streams]);
        },
      }),
    ).rejects.toThrow('stream collision: collision');
    expect(cleaned).toEqual([['owned-1']]);
  });
});
