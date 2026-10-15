import type { ControlAgentSockets } from './control-agent-sockets.ts';
import type { ControlSnapshotPersistence } from './control-snapshot-persistence.ts';
import type { ControlTimers } from './control-timers.ts';

export interface ControlDeadlineSweepInput {
    readonly agentSockets: Pick<ControlAgentSockets, 'sendDispatchableCommandsForConnectedRuns'>;
    readonly persistence: Pick<ControlSnapshotPersistence, 'persist'>;
    readonly timers: ControlTimers;
    readonly intervalMs: number;
}

/**
 * Agent messages dispatch only what they make due at once, so reload deadlines, cleanup refusals, barrier timeouts and
 * the distributed rollup are judged on this fixed cadence instead. Answers the stop of the sweep.
 */
export function startControlDeadlineSweep(input: ControlDeadlineSweepInput): () => void {
    let cancel = input.timers.schedule(sweep, input.intervalMs);

    function sweep(): void {
        if (input.agentSockets.sendDispatchableCommandsForConnectedRuns() > 0) {
            input.persistence.persist();
        }
        cancel = input.timers.schedule(sweep, input.intervalMs);
    }

    return () => cancel();
}
