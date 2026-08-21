import type { RelicAnimationCue, RelicEvent, RelicEventType } from '@relic-hunters/mod.ts';
import { describe, expect, it } from 'vitest';
import { selectRenderableSceneEventCues } from '../src/game/scene/sceneEventBudget.ts';

describe('scene event cue budget', () => {
    it('keeps all renderable cues when the burst is inside the budget', () => {
        const events = [
            event('search', 'player_searched', { type: 'search_altar', durationMs: 700, intensity: 'low' }),
            event('noise', 'noise_pulse', { type: 'noise_pulse', durationMs: 700, intensity: 'low' })
        ];

        expect(selectRenderableSceneEventCues(events, 2).map((candidate) => candidate.id)).toEqual([
            'search',
            'noise'
        ]);
    });

    it('prefers gameplay-result cues over ambient noise when a snapshot has too many cues', () => {
        const events = [
            event('reveal-noise', 'action_revealed', { type: 'noise_pulse', durationMs: 620, intensity: 'low' }),
            event('search', 'player_searched', { type: 'search_altar', durationMs: 700, intensity: 'low' }),
            event('ruin-noise', 'noise_pulse', { type: 'noise_pulse', durationMs: 900, intensity: 'low' })
        ];

        expect(selectRenderableSceneEventCues(events).map((candidate) => candidate.id)).toEqual(['search']);
    });

    it('keeps the latest ambient cue when the burst contains only ambient cues', () => {
        const events = [
            event('old-noise', 'noise_pulse', { type: 'noise_pulse', durationMs: 620, intensity: 'low' }, 1),
            event('new-noise', 'noise_pulse', { type: 'noise_pulse', durationMs: 900, intensity: 'low' }, 2)
        ];

        expect(selectRenderableSceneEventCues(events).map((candidate) => candidate.id)).toEqual(['new-noise']);
    });

    it('can disable scene cue rendering without hiding timeline events', () => {
        const events = [
            event('search', 'player_searched', { type: 'search_altar', durationMs: 700, intensity: 'low' })
        ];

        expect(selectRenderableSceneEventCues(events, 0)).toEqual([]);
    });
});

function event(
    id: string,
    type: RelicEventType,
    animationCue: RelicAnimationCue,
    createdAtEpochMs = 1
): RelicEvent {
    return {
        id,
        round: 1,
        type,
        message: id,
        animationCue,
        createdAtEpochMs
    };
}
