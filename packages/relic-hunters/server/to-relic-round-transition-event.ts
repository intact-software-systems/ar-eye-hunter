import {
    type RelicEventType,
    type RelicGamePhase,
    type RelicGameState,
    type RelicRoundTransition,
    type RelicRoundTransitionEvent
} from '@relic-hunters/mod.ts';
interface RelicRoundTransitionRule {
    readonly transition: RelicRoundTransition;
    /** The rules' event that the transition appends, whose message is the transition's text. */
    readonly eventType: RelicEventType;
}

type RelicPhaseChange = `${RelicGamePhase}:${RelicGamePhase}`;

const RELIC_ROUND_TRANSITION_RULES: Readonly<Partial<Record<RelicPhaseChange, RelicRoundTransitionRule>>> = {
    'lobby:planning': { transition: 'round-started', eventType: 'round_started' },
    'planning:review': { transition: 'round-resolved', eventType: 'action_revealed' },
    'review:planning': { transition: 'review-continued', eventType: 'round_started' },
    'review:finished': { transition: 'finished', eventType: 'game_finished' }
};

/**
 * A command made a round transition when it moved the game's phase along a round: the lobby into the
 * first round, a round into its review, a review into the next round or the finish. Undefined for
 * every other command, the ones that leave the phase where it was among them.
 */
export function toRelicRoundTransitionEvent(
    previous: RelicGameState,
    next: RelicGameState
): RelicRoundTransitionEvent | undefined {
    const rule = RELIC_ROUND_TRANSITION_RULES[`${previous.phase}:${next.phase}`];
    if (rule === undefined) {
        return undefined;
    }
    return {
        protocolVersion: next.protocolVersion,
        gameId: next.gameId,
        createdAtEpochMs: next.createdAtEpochMs,
        round: next.round,
        phase: next.phase,
        transition: rule.transition,
        text: next.events.findLast((event) => event.type === rule.eventType)?.message ?? ''
    };
}
