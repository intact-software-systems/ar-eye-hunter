import type {
    ControlFleetAgentRunOutcome,
    ControlFleetRegionSummary,
    ControlFleetTimingDistribution
} from '@shared-test/rallar-bb-test/fleet-report.ts';

export const UNLABELED_REGION = 'unlabeled-region';

interface FleetRegionGroup {
    readonly region: string;
    readonly provider: string;
    readonly rows: ControlFleetAgentRunOutcome[];
}

const UNKNOWN_PROVIDER = 'unknown-provider';

export function toFleetTimingDistribution(values: readonly number[]): ControlFleetTimingDistribution {
    const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
    return {
        count: sorted.length,
        minMs: sorted[0],
        p50Ms: toPercentile(sorted, 0.5),
        p90Ms: toPercentile(sorted, 0.9),
        p95Ms: toPercentile(sorted, 0.95),
        maxMs: sorted[sorted.length - 1]
    };
}

export function toFleetRegionSummaries(
    outcomes: readonly ControlFleetAgentRunOutcome[]
): readonly ControlFleetRegionSummary[] {
    const groups = new Map<string, FleetRegionGroup>();
    for (const outcome of outcomes) {
        const region = outcome.label.region ?? UNLABELED_REGION;
        const provider = outcome.label.provider ?? UNKNOWN_PROVIDER;
        const key = JSON.stringify([region, provider]);
        const group = groups.get(key) ?? { region, provider, rows: [] };
        group.rows.push(outcome);
        groups.set(key, group);
    }
    return [...groups.values()]
        .map(toFleetRegionSummary)
        .sort((left, right) =>
            left.region.localeCompare(right.region) || (left.provider ?? '').localeCompare(right.provider ?? '')
        );
}

export function toRatio(numerator: number, denominator: number): number {
    return denominator > 0 ? numerator / denominator : 0;
}

export function toSortedUniqueValues(values: readonly string[]): readonly string[] {
    return [...new Set(values)].sort();
}

function toFleetRegionSummary({ region, provider, rows }: FleetRegionGroup): ControlFleetRegionSummary {
    const passed = rows.filter((row) => row.state === 'passed').length;
    return {
        region,
        provider,
        agentCount: rows.length,
        passed,
        failed: rows.filter((row) => row.state === 'failed' || row.state === 'timed-out').length,
        missing: rows.filter((row) => row.missing).length,
        flaky: rows.filter((row) => row.flaky).length,
        stale: rows.filter((row) => row.stale).length,
        passRate: toRatio(passed, rows.length),
        timing: toFleetTimingDistribution(rows.flatMap((row) => row.durationMs === undefined ? [] : [row.durationMs])),
        dominantFailureSignatureId: toDominantValue(rows.flatMap((row) => row.failureSignatureIds))
    };
}

function toDominantValue(values: readonly string[]): string | undefined {
    const counts = new Map<string, number>();
    values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
    return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
}

function toPercentile(sorted: readonly number[], point: number): number | undefined {
    if (sorted.length === 0) {
        return undefined;
    }
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * point) - 1));
    return sorted[index];
}
