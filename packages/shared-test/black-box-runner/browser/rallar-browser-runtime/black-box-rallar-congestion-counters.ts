import type {
    ALCongestionCounters,
    ALOutboundCongestionDiagnostic,
    ALOutboundRuntimeDiagnosticsEvent
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';

/**
 * The page's congestion decisions, refused RTC hand-offs and peak RTC queue, counted off the outbound diagnostics
 * the runtime relays. One count spans one connection: the runtime's `close` resets it, so a reconnect counts from zero.
 */
export interface BlackBoxRallarCongestionCounters {
    observe(event: ALOutboundRuntimeDiagnosticsEvent): void;
    getCounters(): ALCongestionCounters;
    reset(): void;
}

const NO_CONGESTION: ALCongestionCounters = {
    dropped: 0,
    deferred: 0,
    handedOver: 0,
    rateLimited: 0,
    circuitOpen: 0,
    queuedBytesHighWater: 0
};

export function createBlackBoxRallarCongestionCounters(): BlackBoxRallarCongestionCounters {
    let counters = NO_CONGESTION;
    return {
        observe(event) {
            counters = computeCongestionCounters(counters, event);
        },
        getCounters: () => counters,
        reset() {
            counters = NO_CONGESTION;
        }
    };
}

function computeCongestionCounters(
    counters: ALCongestionCounters,
    event: ALOutboundRuntimeDiagnosticsEvent
): ALCongestionCounters {
    switch (event.kind) {
        case 'congestion':
            return computeCongestionActionCounters(counters, event.action);
        case 'rtc-handoff-refusal':
            return event.reason === 'rate-limited'
                ? { ...counters, rateLimited: counters.rateLimited + event.messageCount }
                : { ...counters, circuitOpen: counters.circuitOpen + event.messageCount };
        case 'rtc-queued-bytes-high-water':
            return {
                ...counters,
                queuedBytesHighWater: Math.max(counters.queuedBytesHighWater, event.queuedBytes)
            };
        default:
            return counters;
    }
}

function computeCongestionActionCounters(
    counters: ALCongestionCounters,
    action: ALOutboundCongestionDiagnostic['action']
): ALCongestionCounters {
    switch (action) {
        case 'drop':
            return { ...counters, dropped: counters.dropped + 1 };
        case 'defer':
            return { ...counters, deferred: counters.deferred + 1 };
        case 'hand-over':
            return { ...counters, handedOver: counters.handedOver + 1 };
    }
}
