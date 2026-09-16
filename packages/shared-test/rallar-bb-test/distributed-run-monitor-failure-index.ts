import type { MutableDistributedRunMonitorDerivationWork } from './distributed-run-monitor-derivation-work.ts';
import type { DistributedRunMonitorIndex } from './distributed-run-monitor-index.ts';
import type {
    DistributedRunFailureRow,
    DistributedRunRuntimeDiagnosticRow
} from './distributed-run-observation/distributed-run-row-contracts.ts';

const DIAGNOSTIC_FAILURE_CORRELATION_WINDOW_MS = 15_000;

interface TimedFailurePosition {
    readonly atEpochMs: number;
    readonly position: number;
}

export interface DistributedRunMonitorFailureIndex {
    readonly failures: readonly DistributedRunFailureRow[];
    readonly positionsByCommandKey: ReadonlyMap<string, readonly number[]>;
    readonly timedPositionsByAgentId: ReadonlyMap<string, readonly TimedFailurePosition[]>;
    readonly work: MutableDistributedRunMonitorDerivationWork;
}

export function createDistributedRunMonitorFailureIndex(
    failures: readonly DistributedRunFailureRow[],
    monitorIndex: DistributedRunMonitorIndex
): DistributedRunMonitorFailureIndex {
    const positionsByCommandKey = new Map<string, number[]>();
    const timedPositionsByAgentId = new Map<string, TimedFailurePosition[]>();
    failures.forEach((failure, position) => {
        monitorIndex.work.failureIndexVisitCount += 1;
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
    return {
        failures,
        positionsByCommandKey,
        timedPositionsByAgentId,
        work: monitorIndex.work
    };
}

export function computeDistributedRunCorrelatedFailureKeys(
    diagnostic: Omit<DistributedRunRuntimeDiagnosticRow, 'correlatedFailureKeys'>,
    index: DistributedRunMonitorFailureIndex
): readonly string[] {
    const positions = new Set<number>();
    if (diagnostic.commandId) {
        index.positionsByCommandKey.get(diagnostic.commandId)?.forEach((position) => {
            index.work.diagnosticFailureCandidateVisitCount += 1;
            positions.add(position);
        });
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
            index.work.diagnosticFailureCandidateVisitCount += 1;
            positions.add(candidate.position);
        }
    }
    return [...positions]
        .sort((left, right) => left - right)
        .map((position) => index.failures[position]!.key);
}

function computeTimedFailureLowerBound(
    values: readonly TimedFailurePosition[],
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
