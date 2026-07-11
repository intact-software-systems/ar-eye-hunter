import type {
    ControlFleetRunReport,
    ControlFleetTimingDistribution,
} from '../../../control-run-manager.ts';
import type { FleetTimingGroup } from './fleet-types.ts';
import { fleetRegionKey } from './fleet-presentation.ts';

export function fleetTimingGroupsByRegion(
    reports: readonly ControlFleetRunReport[],
): readonly FleetTimingGroup[] {
    const durations = new Map<string, number[]>();
    reports.forEach((report) => {
        report.agents.forEach((agent) => {
            if (agent.durationMs === undefined) {
                return;
            }
            const key = fleetRegionKey(agent.label);
            const list = durations.get(key) ?? [];
            list.push(agent.durationMs);
            durations.set(key, list);
        });
    });
    return [...durations.entries()]
        .map(([id, values]) => ({
            id,
            label: id,
            timing: fleetTimingDistribution(values),
        }))
        .sort((left, right) =>
            (right.timing.p95Ms ?? 0) - (left.timing.p95Ms ?? 0)
        );
}

export function fleetTimingGroupsByRecipe(
    reports: readonly ControlFleetRunReport[],
): readonly FleetTimingGroup[] {
    const durations = new Map<string, number[]>();
    reports.forEach((report) => {
        if (report.runDurationMs === undefined) {
            return;
        }
        report.recipeIds.forEach((recipeId) => {
            const list = durations.get(recipeId) ?? [];
            list.push(report.runDurationMs as number);
            durations.set(recipeId, list);
        });
    });
    return [...durations.entries()]
        .map(([id, values]) => ({
            id,
            label: id,
            timing: fleetTimingDistribution(values),
        }))
        .sort((left, right) =>
            (right.timing.p95Ms ?? 0) - (left.timing.p95Ms ?? 0)
        );
}

export function fleetTimingDistribution(
    values: readonly number[],
): ControlFleetTimingDistribution {
    const sorted = values
        .filter((value) => Number.isFinite(value))
        .sort((left, right) => left - right);
    if (sorted.length === 0) {
        return { count: 0 };
    }
    return {
        count: sorted.length,
        minMs: sorted[0],
        p50Ms: percentile(sorted, 0.5),
        p90Ms: percentile(sorted, 0.9),
        p95Ms: percentile(sorted, 0.95),
        maxMs: sorted[sorted.length - 1],
    };
}

function percentile(sortedValues: readonly number[], percentileValue: number): number {
    const index = Math.max(
        0,
        Math.min(
            sortedValues.length - 1,
            Math.ceil(sortedValues.length * percentileValue) - 1,
        ),
    );
    return sortedValues[index];
}
