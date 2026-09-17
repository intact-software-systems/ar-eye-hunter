import type { ControlEventEnvelope } from './control-protocol.ts';

/** An event names a distributed run when its payload's JSON text holds the run id; a payload with no JSON text names none. */
export function hasDistributedRunReference(event: ControlEventEnvelope, distributedRunId: string): boolean {
    if (!distributedRunId) {
        return false;
    }
    try {
        return JSON.stringify(event.payload).includes(distributedRunId);
    }
    catch {
        return false;
    }
}
