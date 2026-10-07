import {
    isRelicHunterEvent,
    RELIC_TOPICS,
    RELIC_TYPES,
    toRelicRoomGroupRef,
    type RelicHunterEvent
} from '@relic-hunters/mod.ts';
import type { RallarFacade, RallarMessage, RallarUnsubscribe } from '@shared-web/browser/rallar.ts';
import { readALTargetGroupRef } from '@shared/al-contracts/al-contract.ts';
import { readALPrincipalBroadcastTarget } from '@shared/al-contracts/read-al-principal-broadcast-target.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

export interface RelicHunterEventSubscription {
    /** The signed-in hunter's principal, whose own sessions in the room the server addresses. */
    readonly principalId: string;
    /** This session, the player the game knows; an event of the principal's other session is another player's. */
    readonly playerId: string;
    readonly onEvent: (event: RelicHunterEvent) => void;
}

/**
 * What the server told this session's hunter alone: the action it recorded, or the rule that refused a command. An
 * event of another room, another game, another principal or another session is not this player's.
 */
export function subscribeRelicHunterEvents(
    facade: Pick<RallarFacade, 'messages'>,
    roomId: string,
    subscription: RelicHunterEventSubscription
): RallarUnsubscribe {
    const roomRef = toRelicRoomGroupRef(roomId);
    const channel = facade.messages.room<RelicHunterEvent>({
        topicId: RELIC_TOPICS.hunter,
        typeId: RELIC_TYPES.hunter,
        roomRef,
        purpose: 'notification'
    });
    return channel.onWs((payload, message) => {
        if (
            isRelicHunterEvent(payload) && payload.gameId === roomId && payload.playerId === subscription.playerId &&
            isHunterMessage(message, roomRef, subscription.principalId)
        ) {
            subscription.onEvent(payload);
        }
    });
}

function isHunterMessage(message: RallarMessage<RelicHunterEvent>, roomRef: GroupRef, principalId: string): boolean {
    const target = readALTargetGroupRef(message.raw);
    return readALPrincipalBroadcastTarget(message.raw)?.principalId === principalId && target !== undefined &&
        isSameGroupRef(target, roomRef);
}
