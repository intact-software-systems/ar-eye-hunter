import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';

export const RTC_TOPOLOGY_DELIVERY_LOG_BENCHMARK_POLICY = Object.freeze({
    appendCount: 300,
    concurrency: 10,
    duplicateRaceCount: 30,
    rollbackCount: 100,
    leaseDurationMs: 120_000,
    retentionMs: 3_600_000
});

export interface BenchmarkSql extends PSqlSql {
    end(): Promise<void>;
}

export interface LatencySummary {
    readonly p50: number;
    readonly p95: number;
    readonly p99: number;
}

export interface WorkloadVerification {
    readonly rowCount: number;
    readonly headCount: number;
    readonly contiguous: boolean;
    readonly streamHeads: Readonly<Record<string, number>>;
}

export interface WorkloadResult {
    readonly name: string;
    readonly streamCount: number;
    readonly operationCount: number;
    readonly durationMs: number;
    readonly throughputPerSecond: number;
    readonly latencyMs: LatencySummary;
    readonly transactionRetries: number;
    readonly verification: WorkloadVerification;
}

export function summarizeRtcTopologyDeliveryLatencies(samples: readonly number[]): LatencySummary {
    if (samples.length === 0) {
        throw new TypeError('RTC topology delivery benchmark latency samples are required');
    }
    const sorted = [...samples].sort((left, right) => left - right);
    return {
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        p99: percentile(sorted, 0.99)
    };
}

function percentile(sorted: readonly number[], fraction: number): number {
    return sorted[Math.ceil(sorted.length * fraction) - 1]!;
}
