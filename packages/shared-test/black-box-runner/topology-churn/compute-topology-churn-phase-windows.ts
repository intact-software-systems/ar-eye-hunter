import type { TopologyChurnPhaseWindow } from './compute-topology-churn-report.ts';
import type { TopologyChurnEvent } from './resolve-topology-churn-event.ts';

export interface ComputeTopologyChurnPhaseWindowsInput {
    readonly formationStartedAtEpochMs: number;
    readonly lastPresenceAnsweredAtEpochMs: number;
    /** Every member joins during formation, the creator included. */
    readonly memberCount: number;
    readonly settleMs: number;
    readonly churnEndedAtEpochMs: number;
    readonly churnEvents: readonly TopologyChurnEvent[];
}

export function computeTopologyChurnPhaseWindows(
    input: ComputeTopologyChurnPhaseWindowsInput
): readonly TopologyChurnPhaseWindow[] {
    const formationEndedAtEpochMs = input.lastPresenceAnsweredAtEpochMs + input.settleMs;
    return [
        {
            name: 'formation',
            startedAtEpochMs: input.formationStartedAtEpochMs,
            endedAtEpochMs: formationEndedAtEpochMs,
            joinCount: input.memberCount,
            leaveCount: 0
        },
        {
            name: 'churn',
            startedAtEpochMs: formationEndedAtEpochMs,
            endedAtEpochMs: input.churnEndedAtEpochMs,
            joinCount: input.churnEvents.filter((event) => event.kind === 'join').length,
            leaveCount: input.churnEvents.filter((event) => event.kind === 'leave').length
        }
    ];
}
