import {
    isRelicRoundTrackOfGame,
    isRelicRoundTransitionEvent,
    RELIC_TOPICS,
    RELIC_TYPES,
    type RelicRoundTransitionEvent
} from '@relic-hunters/mod.ts';
import type { RallarFacade, RallarMessage, RallarUnsubscribe } from '@shared-web/browser/rallar.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { DEFAULT_STATE_APPLICATION_ID, DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';

export interface RelicRoundTransitionSubscription {
    readonly onTransition: (event: RelicRoundTransitionEvent) => void;
    /** The receiver can no longer order the room's round transitions; the game is read again instead. */
    readonly onResyncRequired: () => void;
}

/**
 * The room's round transitions arrive in the order the server sequenced them on the game's track for
 * each round. A message of another room, or another game, is not the room's to cue.
 */
export function subscribeRelicRoundTransitions(
    facade: Pick<RallarFacade, 'messages'>,
    roomId: string,
    subscription: RelicRoundTransitionSubscription
): RallarUnsubscribe {
    const roomRef: GroupRef = {
        applicationId: DEFAULT_STATE_APPLICATION_ID,
        workspaceId: DEFAULT_STATE_WORKSPACE_ID,
        groupId: roomId
    };
    const channel = facade.messages.room<RelicRoundTransitionEvent>({
        topicId: RELIC_TOPICS.event,
        typeId: RELIC_TYPES.event,
        roomRef,
        purpose: 'notification',
        recovery: {
            onResyncRequired: (cursor) => {
                if (isRelicRoundTrackOfGame(cursor.orderingKey, roomId)) {
                    subscription.onResyncRequired();
                }
            }
        }
    });
    return channel.onWs((payload, message) => {
        if (isRelicRoundTransitionEvent(payload) && payload.gameId === roomId && isRoomMessage(message, roomRef)) {
            subscription.onTransition(payload);
        }
    });
}

function isRoomMessage(message: RallarMessage<RelicRoundTransitionEvent>, roomRef: GroupRef): boolean {
    const targets = message.raw.targets;
    return targets?.mode === 'broadcast' &&
        targets.scope === 'room' &&
        targets.groupRef !== undefined &&
        isSameGroupRef(targets.groupRef, roomRef);
}
