import { describe, expect, it } from 'vitest';

import {
  RTC_TOPOLOGY_DELIVERY_LOG_BENCHMARK_POLICY,
  summarizeRtcTopologyDeliveryLatencies,
} from '../../topology-delivery/delivery-log-bench.ts';

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
});
