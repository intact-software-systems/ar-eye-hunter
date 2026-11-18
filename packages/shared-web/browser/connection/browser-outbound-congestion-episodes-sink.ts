import type { BrowserDeliverySettlements } from '@shared-web/browser/connection/browser-delivery-settlements.ts';
import type { ALDeliverySettlementSink } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundRuntimeDiagnosticsSink } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    AL_CONGESTION_MAX_OPEN_EPISODES,
    ALOutboundCongestionEpisodes
} from '@shared/alm/outbound/congestion/al-outbound-congestion-episodes.ts';

export namespace BrowserOutboundCongestionEpisodesSink {
    export interface Wrapped {
        readonly diagnostics: ALOutboundRuntimeDiagnosticsSink;
        readonly settlements: BrowserDeliverySettlements.Carriers;
    }
}

/**
 * One connect's outbound diagnostics port and settlement sinks with its congestion episodes measured in front of
 * them: a deferral arrives on the first and its attempt's settlement on the second, so only the connect sees both.
 */
export class BrowserOutboundCongestionEpisodesSink {
    public readonly diagnostics: ALOutboundRuntimeDiagnosticsSink;
    public readonly settlements: BrowserDeliverySettlements.Carriers;
    private readonly episodes = new ALOutboundCongestionEpisodes({ maxOpenEpisodes: AL_CONGESTION_MAX_OPEN_EPISODES });

    public constructor(wrapped: BrowserOutboundCongestionEpisodesSink.Wrapped) {
        this.diagnostics = (event) => {
            this.episodes.recordDiagnostic(event);
            wrapped.diagnostics(event);
        };
        this.settlements = {
            ws: this.toMeasuredSettlementSink(wrapped.settlements.ws),
            rtc: this.toMeasuredSettlementSink(wrapped.settlements.rtc)
        };
    }

    public readReport(): ALOutboundCongestionEpisodes.Figures {
        return this.episodes.readFigures();
    }

    private toMeasuredSettlementSink(wrapped: ALDeliverySettlementSink): ALDeliverySettlementSink {
        return (settlement) => {
            this.episodes.recordSettlement(settlement);
            wrapped(settlement);
        };
    }
}
