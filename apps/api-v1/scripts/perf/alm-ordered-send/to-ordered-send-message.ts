import {
    newALBroadcastMessage,
    newALRoute,
    toALGroupTargetKey,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { AL_CHANNEL_SEND_DEFAULTS } from '@shared/al-contracts/resolve-al-channel-send-defaults.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import type { OrderedSendScheduledSend } from './compute-ordered-send-schedule.ts';

export interface ToOrderedSendMessageInput {
    readonly send: OrderedSendScheduledSend;
    readonly roomRef: GroupRef;
    readonly createdAtEpochMs: number;
}

/**
 * The topic and the payload type of every send, as a browser names both alike when its send names no topic. It is an
 * implicit `room.` topic: the server's router has no definition of it, so its fan-out is the router's default.
 */
export const ORDERED_SEND_TOPIC_ID = 'room.ordered-send';

/**
 * The envelope a browser's `notification` channel gives an ordered room send on the WS carrier: a room broadcast of
 * its publisher with the channel's reliability, receipt, lifetime and durability, on the room's ordering key at the
 * seq the schedule gave it. A publisher is its track's only sender, so each publisher has a track of its own. It
 * states no roster or snapshot floor, as a browser's room view would.
 */
export function toOrderedSendMessage(input: ToOrderedSendMessageInput): ALMessage {
    const { send, roomRef, createdAtEpochMs } = input;
    const { reliability, ack, ttlMs, durability } = AL_CHANNEL_SEND_DEFAULTS.notification;
    const message = newALBroadcastMessage({
        senderId: send.publisherPeerId,
        createdAtEpochMs,
        route: newALRoute(ORDERED_SEND_TOPIC_ID, roomRef.groupId, send.msgId),
        scope: 'room',
        typeId: ORDERED_SEND_TOPIC_ID,
        resource: { seq: send.seq },
        options: {
            groupRef: roomRef,
            ttlMs,
            reliability,
            ack,
            ownership: 'shared',
            qos: { durability: { algo: durability } },
            ordering: { orderingKey: toALGroupTargetKey(roomRef), seq: send.seq }
        }
    });
    return { ...message, id: { ...message.id, msgId: send.msgId } };
}
