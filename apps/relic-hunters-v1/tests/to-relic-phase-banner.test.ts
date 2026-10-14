import { RELIC_PROTOCOL_VERSION, type RelicRoundTransitionEvent } from '@relic-hunters/mod.ts';
import { describe, expect, it } from 'vitest';
import { UI } from '../src/game/lang.ts';
import { toRelicPhaseBanner } from '../src/game/to-relic-phase-banner.ts';

describe('the phase banner of a round transition', () => {
    it('cues each transition the server ordered, the first round\'s start held longest', () => {
        const banners = [
            toTransition(1, 'planning', 'round-started'),
            toTransition(1, 'review', 'round-resolved'),
            toTransition(2, 'planning', 'review-continued'),
            toTransition(2, 'finished', 'finished')
        ].map((event) => toRelicPhaseBanner(event, 'en'));

        expect(banners).toEqual([
            { text: UI.en.phaseBannerPlanning, start: true, durationMs: 4_000 },
            { text: 'Plans are revealed.', start: false, durationMs: 2_400 },
            { text: UI.en.phaseBannerPlanning, start: false, durationMs: 2_400 },
            { text: 'The ruin falls silent.', start: false, durationMs: 2_400 }
        ]);
        expect(toRelicPhaseBanner(toTransition(1, 'planning', 'round-started'), 'no').text).toBe(UI.no.phaseBannerPlanning);
    });
});

function toTransition(
    round: number,
    phase: RelicRoundTransitionEvent['phase'],
    transition: RelicRoundTransitionEvent['transition']
): RelicRoundTransitionEvent {
    return { protocolVersion: RELIC_PROTOCOL_VERSION, gameId: 'room-1', createdAtEpochMs: 1, round, phase, transition, text: '' };
}
