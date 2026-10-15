import { startRepeating } from '@shared/resilience/start-repeating.ts';
import type { Timers } from '@shared/resilience/timers.ts';

import type { ControlAgentSockets } from './control-agent-sockets.ts';
import type { ControlSnapshotPersistence } from './control-snapshot-persistence.ts';

export interface ControlDeadlineSweepInput {
    readonly agentSockets: Pick<ControlAgentSockets, 'sendDispatchableCommandsForConnectedRuns'>;
    readonly persistence: Pick<ControlSnapshotPersistence, 'persist'>;
    readonly timers: Timers;
    readonly intervalMs: number;
}

/**
 * Agent messages dispatch only what they make due at once, so reload deadlines, cleanup refusals, barrier timeouts and
 * the distributed rollup are judged on this fixed cadence instead. Answers the stop of the sweep.
 */
export function startControlDeadlineSweep(input: ControlDeadlineSweepInput): () => void {
    return startRepeating({
        timers: input.timers,
        intervalMs: input.intervalMs,
        firstRun: 'after-interval',
        run: () => {
            if (input.agentSockets.sendDispatchableCommandsForConnectedRuns() > 0) {
                input.persistence.persist();
            }
        }
    });
}
