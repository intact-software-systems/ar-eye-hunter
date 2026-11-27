import {
    AL_WS_CLIENT_CAPABILITIES,
    toALCarrierQosInputProvider
} from '@shared/al-contracts/al-carrier-capabilities.ts';
import {
    newALBroadcastMessage,
    newALRoute,
    toALGroupTargetKey,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import {
    normalizeALQosPolicy,
    resolveALQosNormalizationInput,
    type ALQosInputProvider
} from '@shared/al-contracts/al-policy.ts';
import { AL_CHANNEL_SEND_DEFAULTS } from '@shared/al-contracts/resolve-al-channel-send-defaults.ts';
import { toProofPreservingALOutboundMessage } from '@shared/alm/outbound/to-al-outbound-message.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import type { RoomSendScheduledSend } from './compute-room-send-schedule.ts';
import type { RoomSendOrdering } from './room-send-ordering.ts';

export interface ToRoomSendMessageInput {
    readonly send: RoomSendScheduledSend;
    readonly roomRef: GroupRef;
    readonly createdAtEpochMs: number;
    readonly ordering: RoomSendOrdering;
}

/**
 * The QoS provider a browser's WS client plans its sends with: the WS client's capabilities over the empty provider
 * a browser session is composed with. A browser also reads its session's volatile bound through it and plans a send
 * `overloaded` past that bound; a publisher of the cell has no such bound.
 */
export const ROOM_SEND_WS_CLIENT_QOS_PROVIDER: ALQosInputProvider = toALCarrierQosInputProvider(
    AL_WS_CLIENT_CAPABILITIES,
    {}
);

/**
 * The topic and the payload type of every send, as a browser names both alike when its send names no topic. It is an
 * implicit `room.` topic: the server's router has no definition of it, so its fan-out is the router's default.
 */
const ROOM_SEND_TOPIC_ID = 'room.cell-send';

/**
 * The message a browser's WS client writes to its socket for a room send of its `notification` channel: a room
 * broadcast of its publisher with the channel's reliability, receipt, lifetime and durability, as the client's own
 * planning leaves it. The client normalizes the envelope's QoS as an open socket's sender
 * (`toWsQueueBoxClientDispatchPlan`) and writes the expiry it selected into the frame
 * (`toProofPreservingALOutboundMessage`); both steps here are the product's own.
 *
 * Under `ordering-key` the send is on the room's ordering key at the seq the schedule gave it; a publisher is its
 * track's only sender, so each publisher has a track of its own. Under `unordered` the envelope is the same with no
 * ordering key and no seq. The payload states the send's number among its publisher's offers under both.
 *
 * It carries no room send fence. A browser's room send carries the fence its room view resolves
 * (`resolveRoomSendFence` of `BrowserRallarMessageSender`), which the server checks the send against; this envelope
 * states none, so no send of a run is refused or retained for its fence.
 */
export function toRoomSendMessage(input: ToRoomSendMessageInput): ALMessage {
    const envelope = toRoomSendEnvelope(input);
    const { publisherPeerId } = input.send;
    const policy = normalizeALQosPolicy(
        envelope,
        resolveALQosNormalizationInput(
            envelope,
            { direction: 'outbound', selfPeerId: publisherPeerId, connectedPeerIds: [publisherPeerId] },
            ROOM_SEND_WS_CLIENT_QOS_PROVIDER
        )
    );
    return toProofPreservingALOutboundMessage(envelope, policy.effective);
}

/** The send as a browser's `notification` channel hands it to its WS client. */
function toRoomSendEnvelope(input: ToRoomSendMessageInput): ALMessage {
    const { send, roomRef, createdAtEpochMs, ordering } = input;
    const { reliability, ack, ttlMs, durability } = AL_CHANNEL_SEND_DEFAULTS.notification;
    const trackPlace = ordering === 'ordering-key'
        ? { ordering: { orderingKey: toALGroupTargetKey(roomRef), seq: send.seq } }
        : {};
    const message = newALBroadcastMessage({
        senderId: send.publisherPeerId,
        createdAtEpochMs,
        route: newALRoute(ROOM_SEND_TOPIC_ID, roomRef.groupId, send.msgId),
        scope: 'room',
        typeId: ROOM_SEND_TOPIC_ID,
        resource: { seq: send.seq },
        options: {
            groupRef: roomRef,
            ttlMs,
            reliability,
            ack,
            ownership: 'shared',
            qos: { durability: { algo: durability } },
            ...trackPlace
        }
    });
    return { ...message, id: { ...message.id, msgId: send.msgId } };
}
