import type {
    ControlDistributedRunSnapshot,
    ControlQueuedCommandSnapshot
} from '../control-snapshots.ts';
import type { DistributedRunSlowestAgent } from '../distributed-artifact-analysis.ts';
import type { DistributedRunResultEvidence } from '../distributed-artifact-analysis/decode-distributed-run-result-evidence.ts';
import { computeAverage, computeElapsedMs, computeMaxNumber } from './compute-timing-summary.ts';

/** One command's duration; the command and agent are absent when the result or envelope does not name them. */
export interface CommandTimingSample {
    readonly commandId?: string;
    readonly agentId?: string;
    readonly durationMs: number;
}

export interface CommandTimingSources {
    readonly distributedRun: ControlDistributedRunSnapshot;
    readonly commands: readonly ControlQueuedCommandSnapshot[];
    readonly controlResults: readonly DistributedRunResultEvidence[];
}

const SLOWEST_AGENT_LIMIT = 5;

/**
 * Queued command timings come first; a result adds a sample only for a command no queued record timed.
 * A run that links commands samples only the linked ones.
 */
export function computeCommandTimingSamples(sources: CommandTimingSources): readonly CommandTimingSample[] {
    const linkedCommandIds = new Set(sources.distributedRun.commandLinks.map((link) => link.commandId));
    const isSampled = (commandId: string | undefined) =>
        linkedCommandIds.size === 0 || (commandId !== undefined && linkedCommandIds.has(commandId));
    const commandSamples = sources.commands.flatMap((command) => {
        const sample = toCommandTimingSample(command);
        return sample !== undefined && isSampled(sample.commandId) ? [sample] : [];
    });
    const sampledCommandIds = new Set(commandSamples.flatMap((sample) => sample.commandId ?? []));
    const resultSamples: CommandTimingSample[] = [];
    for (const result of sources.controlResults) {
        const { commandId, durationMs } = result;
        if (!isSampled(commandId) || (commandId && sampledCommandIds.has(commandId)) || durationMs === undefined) {
            continue;
        }
        if (commandId) {
            sampledCommandIds.add(commandId);
        }
        resultSamples.push({ commandId, agentId: result.agentId, durationMs });
    }
    return [...commandSamples, ...resultSamples];
}

export function computeSlowestAgents(samples: readonly CommandTimingSample[]): readonly DistributedRunSlowestAgent[] {
    const durationsByAgent = new Map<string, number[]>();
    for (const sample of samples) {
        if (!sample.agentId) {
            continue;
        }
        const durations = durationsByAgent.get(sample.agentId);
        if (durations) {
            durations.push(sample.durationMs);
        }
        else {
            durationsByAgent.set(sample.agentId, [sample.durationMs]);
        }
    }
    return [...durationsByAgent.entries()]
        .map(([agentId, durations]) => ({
            agentId,
            commandCount: durations.length,
            averageMs: computeAverage(durations),
            maxMs: computeMaxNumber(durations)
        }))
        .sort((left, right) =>
            (right.maxMs ?? 0) - (left.maxMs ?? 0) ||
            (right.averageMs ?? 0) - (left.averageMs ?? 0) ||
            left.agentId.localeCompare(right.agentId)
        )
        .slice(0, SLOWEST_AGENT_LIMIT);
}

/** Absent when the command times neither dispatch nor queueing to completion. */
function toCommandTimingSample(command: ControlQueuedCommandSnapshot): CommandTimingSample | undefined {
    const durationMs = computeElapsedMs(command.dispatchedAtEpochMs, command.completedAtEpochMs) ??
        computeElapsedMs(command.queuedAtEpochMs, command.completedAtEpochMs);
    if (durationMs === undefined) {
        return undefined;
    }
    return { commandId: command.envelope.commandId, agentId: command.envelope.agentId, durationMs };
}
