import type {
    ALCongestionCounters,
    ALOutboundCongestionDiagnostic,
    ALOutboundRuntimeDiagnosticsEvent
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';

/**
 * The page's congestion decisions, counted off the outbound diagnostics the runtime relays (D186). One count
 * spans one connection: the runtime's `close` resets it, so a reconnect counts from zero.
 */
export interface BlackBoxRallarCongestionCounters {
    observe(event: ALOutboundRuntimeDiagnosticsEvent): void;
    getCounters(): ALCongestionCounters;
    reset(): void;
}

const NO_CONGESTION: ALCongestionCounters = { dropped: 0, deferred: 0, handedOver: 0 };

export function createBlackBoxRallarCongestionCounters(): BlackBoxRallarCongestionCounters {
    let counters = NO_CONGESTION;
    return {
        observe(event) {
            if (event.kind === 'congestion') {
                counters = computeCongestionCounters(counters, event.action);
            }
        },
        getCounters: () => counters,
        reset() {
            counters = NO_CONGESTION;
        }
    };
}

function computeCongestionCounters(
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
