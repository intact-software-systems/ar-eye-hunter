import {
    RELIC_TOPICS,
    RELIC_TYPES,
    toRelicRoundTrackKey,
    type RelicEventType,
    type RelicGamePhase,
    type RelicGameState,
    type RelicRoundTransition,
    type RelicRoundTransitionEvent
} from '@relic-hunters/mod.ts';
import {
    newALBroadcastMessage,
    newALRoute,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import {
    DEFAULT_STATE_APPLICATION_ID,
    DEFAULT_STATE_WORKSPACE_ID
} from '@shared/api/state-types.ts';

/** How long a round transition stays deliverable and repairable: the default round time limit. */
export const RELIC_EVENT_TTL_MS = 60_000;

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
        round: next.round,
        phase: next.phase,
        transition: rule.transition,
        text: next.events.findLast((event) => event.type === rule.eventType)?.message ?? ''
    };
}

/**
 * The transition rides the ordered track of its round in the game's incarnation: the incarnation keys
 * the track, the round is its epoch, and the server's outbound admission mints the sequence.
 */
export function toRelicRoundTransitionMessage(
    state: RelicGameState,
    event: RelicRoundTransitionEvent,
    serverPeerId: string
): ALMessage {
    return newALBroadcastMessage(
        serverPeerId,
        newALRoute(RELIC_TOPICS.event, state.roomId, `${event.gameId}:${event.round}`),
        'room',
        RELIC_TYPES.event,
        event,
        {
            groupRef: {
                applicationId: DEFAULT_STATE_APPLICATION_ID,
                workspaceId: DEFAULT_STATE_WORKSPACE_ID,
                groupId: state.roomId
            },
            reliability: 'at-least-once',
            ack: 'receiver',
            ttlMs: RELIC_EVENT_TTL_MS,
            ordering: { orderingKey: toRelicRoundTrackKey(state), epoch: event.round }
        }
    );
}
