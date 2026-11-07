import type { ALInboundRuntimeDiagnosticsEvent } from '../al-inbound-runtime-diagnostics.ts';
import type { ALInboundOrderingPosition } from './to-al-inbound-ordering-position.ts';

/**
 * The `ordering-position` events a recipient's admissions stated, by status. They count events, not distinct copies:
 * each repeat arrival below the position states another `before-entry`, and each duplicate witness another `witnessed`.
 */
export interface ALInboundOrderingCounters {
    readonly entered: number;
    readonly omitted: number;
    readonly witnessed: number;
    readonly beforeEntry: number;
}

const COUNTER_BY_STATUS: Readonly<Record<ALInboundOrderingPosition['status'], keyof ALInboundOrderingCounters>> = {
    entered: 'entered',
    omitted: 'omitted',
    witnessed: 'witnessed',
    'before-entry': 'beforeEntry'
};

export function createALInboundOrderingCounters(): ALInboundOrderingCounters {
    return { entered: 0, omitted: 0, witnessed: 0, beforeEntry: 0 };
}

/** The counters with `event` counted; the same counters for an event that states no ordering position. */
export function computeALInboundOrderingCounters(
    counters: ALInboundOrderingCounters,
    event: ALInboundRuntimeDiagnosticsEvent
): ALInboundOrderingCounters {
    if (event.kind !== 'ordering-position') {
        return counters;
    }
    const counter = COUNTER_BY_STATUS[event.status];
    return { ...counters, [counter]: counters[counter] + 1 };
}
