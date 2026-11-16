import type { TopologyChurnPhaseWindow } from './compute-topology-churn-report.ts';
import type { TopologyChurnEvent } from './resolve-topology-churn-event.ts';

export interface ComputeTopologyChurnPhaseWindowsInput {
    readonly formationStartedAtEpochMs: number;
    readonly lastPresenceAnsweredAtEpochMs: number;
    readonly formationJoinCount: number;
    readonly settleMs: number;
    readonly churnStartedAtEpochMs: number;
    readonly churnEndedAtEpochMs: number;
    readonly churnEvents: readonly TopologyChurnEvent[];
}

export function computeTopologyChurnPhaseWindows(
    input: ComputeTopologyChurnPhaseWindowsInput
): readonly TopologyChurnPhaseWindow[] {
    return [
        {
            name: 'formation',
            startedAtEpochMs: input.formationStartedAtEpochMs,
            endedAtEpochMs: input.lastPresenceAnsweredAtEpochMs + input.settleMs,
            joinCount: input.formationJoinCount,
            leaveCount: 0
        },
        {
            name: 'churn',
            startedAtEpochMs: input.churnStartedAtEpochMs,
            endedAtEpochMs: input.churnEndedAtEpochMs,
            joinCount: input.churnEvents.filter((event) => event.kind === 'join').length,
            leaveCount: input.churnEvents.filter((event) => event.kind === 'leave').length
        }
    ];
}
