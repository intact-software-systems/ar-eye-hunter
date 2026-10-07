import type { RelicRoundTransitionEvent } from '@relic-hunters/mod.ts';

import { UI, type Lang } from './lang.ts';

export interface RelicPhaseBanner {
    readonly text: string;
    readonly start: boolean;
    readonly durationMs: number;
}

const RELIC_PHASE_BANNER_MS = 2_400;
const RELIC_START_BANNER_MS = 4_000;

export function toRelicPhaseBanner(event: RelicRoundTransitionEvent, lang: Lang): RelicPhaseBanner {
    switch (event.transition) {
        case 'round-started':
            return { text: UI[lang].phaseBannerPlanning, start: true, durationMs: RELIC_START_BANNER_MS };
        case 'review-continued':
            return { text: UI[lang].phaseBannerPlanning, start: false, durationMs: RELIC_PHASE_BANNER_MS };
        case 'round-resolved':
            return { text: 'Plans are revealed.', start: false, durationMs: RELIC_PHASE_BANNER_MS };
        case 'finished':
            return { text: 'The ruin falls silent.', start: false, durationMs: RELIC_PHASE_BANNER_MS };
    }
}
