import type { TopologyChurnPhaseName, TopologyChurnPhaseWindow } from './compute-topology-churn-report.ts';
import type { TopologyChurnEvent } from './resolve-topology-churn-event.ts';

export interface TopologyChurnPhaseRun {
    readonly name: Exclude<TopologyChurnPhaseName, 'formation'>;
    readonly endedAtEpochMs: number;
    readonly events: readonly TopologyChurnEvent[];
}

interface ComputeTopologyChurnPhaseWindowsInput {
    readonly formationStartedAtEpochMs: number;
    readonly lastPresenceAnsweredAtEpochMs: number;
    /** Every member joins during formation, the creator included. */
    readonly memberCount: number;
    readonly settleMs: number;
    readonly runs: readonly TopologyChurnPhaseRun[];
}

export function computeTopologyChurnPhaseWindows(
    input: ComputeTopologyChurnPhaseWindowsInput
): readonly TopologyChurnPhaseWindow[] {
    const formationEndedAtEpochMs = input.lastPresenceAnsweredAtEpochMs + input.settleMs;
    const runStartsAtEpochMs = [formationEndedAtEpochMs, ...input.runs.map((run) => run.endedAtEpochMs)];
    return [
        {
            name: 'formation',
            startedAtEpochMs: input.formationStartedAtEpochMs,
            endedAtEpochMs: formationEndedAtEpochMs,
            joinCount: input.memberCount,
            leaveCount: 0
        },
        ...input.runs.map((run, index) => ({
            name: run.name,
            startedAtEpochMs: runStartsAtEpochMs[index],
            endedAtEpochMs: run.endedAtEpochMs,
            joinCount: run.events.filter((event) => event.kind === 'join').length,
            leaveCount: run.events.filter((event) => event.kind === 'leave').length
        }))
    ];
}
