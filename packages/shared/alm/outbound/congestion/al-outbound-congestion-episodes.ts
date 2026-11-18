import type { ALDeliveryCarrier } from '../../../al-contracts/al-control-value-codec.ts';
import { LatestRepository } from '../../../cache/LatestRepository.ts';
import { assertBoundedHistogram } from '../../../measurement/assert-bounded-histogram.ts';
import { computeBoundedHistogramAfter, type BoundedHistogram } from '../../../measurement/bounded-histogram.ts';
import type { ALDeliverySettlement } from '../../delivery/al-delivery-lifecycle.ts';
import type { ALOutboundRuntimeDiagnosticsEvent } from '../al-outbound-message-runtime.ts';

export const AL_CONGESTION_EPISODE_BOUNDS_MS: readonly number[] = [
    10,
    20,
    50,
    100,
    200,
    500,
    1000,
    2000,
    5000,
    10000,
    30000,
    60000
];

export const AL_CONGESTION_MAX_OPEN_EPISODES = 1024;

export namespace ALOutboundCongestionEpisodes {
    export interface Config {
        readonly maxOpenEpisodes: number;
    }

    export interface Figures {
        readonly durationMs: BoundedHistogram;
        readonly openEpisodes: number;
        readonly unrecordedSamples: number;
    }
}

export function toIdleALOutboundCongestionEpisodeFigures(): ALOutboundCongestionEpisodes.Figures {
    return {
        durationMs: assertBoundedHistogram(AL_CONGESTION_EPISODE_BOUNDS_MS, 'AL_CONGESTION_EPISODE_BOUNDS_MS'),
        openEpisodes: 0,
        unrecordedSamples: 0
    };
}

function toEpisodeKey(carrier: ALDeliveryCarrier, msgId: string): string {
    return `${carrier}:${msgId}`;
}

function isEpisodeEnd(settlement: ALDeliverySettlement): boolean {
    return settlement.kind === 'expired' ||
        (settlement.kind === 'attempt-settled' && settlement.outcome !== 'not-ready');
}

/**
 * One connect's congestion episodes: a message's first deferral on a carrier to the settlement of the attempt its
 * carrier did not defer again. An episode it lets go at its bound, or cannot measure, is counted, never estimated.
 */
export class ALOutboundCongestionEpisodes {
    private readonly config: ALOutboundCongestionEpisodes.Config;
    private readonly startedAtMsByEpisode: LatestRepository<string, number>;
    private durationMs = toIdleALOutboundCongestionEpisodeFigures().durationMs;
    private unrecordedSamples = 0;

    public constructor(config: ALOutboundCongestionEpisodes.Config) {
        this.config = config;
        this.startedAtMsByEpisode = new LatestRepository({ maxEntries: config.maxOpenEpisodes });
    }

    public recordDiagnostic(event: ALOutboundRuntimeDiagnosticsEvent): void {
        if (event.kind !== 'congestion' || event.action !== 'defer') {
            return;
        }
        const episode = toEpisodeKey(event.carrier, event.msgId);
        if (this.startedAtMsByEpisode.has(episode)) {
            return;
        }
        if (this.startedAtMsByEpisode.size() >= this.config.maxOpenEpisodes) {
            this.unrecordedSamples += 1;
        }
        this.startedAtMsByEpisode.set(episode, event.atMs);
    }

    public recordSettlement(settlement: ALDeliverySettlement): void {
        if (!isEpisodeEnd(settlement)) {
            return;
        }
        const startedAtMs = this.startedAtMsByEpisode.take(toEpisodeKey(settlement.carrier, settlement.msgId));
        if (startedAtMs === undefined) {
            return;
        }
        const recorded = computeBoundedHistogramAfter(this.durationMs, settlement.atMs - startedAtMs);
        if (recorded.right === undefined) {
            this.unrecordedSamples += 1;
            return;
        }
        this.durationMs = recorded.right;
    }

    public readFigures(): ALOutboundCongestionEpisodes.Figures {
        return {
            durationMs: this.durationMs,
            openEpisodes: this.startedAtMsByEpisode.size(),
            unrecordedSamples: this.unrecordedSamples
        };
    }
}
