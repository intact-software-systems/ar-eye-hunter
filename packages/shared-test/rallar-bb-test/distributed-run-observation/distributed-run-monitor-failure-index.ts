import type {
    DistributedRunFailureRow,
    DistributedRunRuntimeDiagnosticRow
} from './distributed-run-row-contracts.ts';

export interface DistributedRunMonitorFailureIndex {
    readonly failures: readonly DistributedRunFailureRow[];
    readonly positionsByCommandKey: ReadonlyMap<string, readonly number[]>;
    readonly timedPositionsByAgentId: ReadonlyMap<string, readonly DistributedRunMonitorTimedFailurePosition[]>;
}

export interface DistributedRunMonitorTimedFailurePosition {
    readonly atEpochMs: number;
    readonly position: number;
}

const DIAGNOSTIC_FAILURE_CORRELATION_WINDOW_MS = 15_000;

export function createDistributedRunMonitorFailureIndex(
    failures: readonly DistributedRunFailureRow[]
): DistributedRunMonitorFailureIndex {
    const positionsByCommandKey = new Map<string, number[]>();
    const timedPositionsByAgentId = new Map<string, DistributedRunMonitorTimedFailurePosition[]>();
    failures.forEach((failure, position) => {
        new Set([failure.commandId, failure.key]).forEach((commandKey) => {
            if (commandKey !== undefined) {
                appendToBucket(positionsByCommandKey, commandKey, position);
            }
        });
        if (failure.agentId !== undefined && failure.atEpochMs !== undefined && Number.isFinite(failure.atEpochMs)) {
            appendToBucket(timedPositionsByAgentId, failure.agentId, { atEpochMs: failure.atEpochMs, position });
        }
    });
    timedPositionsByAgentId.forEach((positions) => {
        positions.sort((left, right) => left.atEpochMs - right.atEpochMs || left.position - right.position);
    });
    return { failures, positionsByCommandKey, timedPositionsByAgentId };
}

export function computeDistributedRunCorrelatedFailureKeys(
    diagnostic: Omit<DistributedRunRuntimeDiagnosticRow, 'correlatedFailureKeys'>,
    index: DistributedRunMonitorFailureIndex
): readonly string[] {
    const positions = new Set<number>();
    if (diagnostic.commandId) {
        index.positionsByCommandKey.get(diagnostic.commandId)?.forEach((position) => positions.add(position));
    }
    if (diagnostic.agentId && Number.isFinite(diagnostic.atEpochMs)) {
        const timedPositions = index.timedPositionsByAgentId.get(diagnostic.agentId) ?? [];
        const minimum = diagnostic.atEpochMs - DIAGNOSTIC_FAILURE_CORRELATION_WINDOW_MS;
        const maximum = diagnostic.atEpochMs + DIAGNOSTIC_FAILURE_CORRELATION_WINDOW_MS;
        const start = computeTimedFailureLowerBound(timedPositions, minimum);
        for (let cursor = start; cursor < timedPositions.length; cursor += 1) {
            const candidate = timedPositions[cursor]!;
            if (candidate.atEpochMs > maximum) {
                break;
            }
            positions.add(candidate.position);
        }
    }
    return [...positions]
        .sort((left, right) => left - right)
        .map((position) => index.failures[position]!.key);
}

function computeTimedFailureLowerBound(
    values: readonly DistributedRunMonitorTimedFailurePosition[],
    minimum: number
): number {
    let low = 0;
    let high = values.length;
    while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (values[middle]!.atEpochMs < minimum) {
            low = middle + 1;
        }
        else {
            high = middle;
        }
    }
    return low;
}

function appendToBucket<Value>(buckets: Map<string, Value[]>, key: string, value: Value): void {
    const bucket = buckets.get(key);
    if (bucket === undefined) {
        buckets.set(key, [value]);
    }
    else {
        bucket.push(value);
    }
}
