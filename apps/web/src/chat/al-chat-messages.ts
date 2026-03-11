import { ALMessage, ALRoute, newALMulticastMessage, } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';

// -------------------------------------------------------
// Type ids
// -------------------------------------------------------

export const AL_CHAT_TEXT_TYPE_ID = AppTopics.chat;

// -------------------------------------------------------
// Topic ids
// -------------------------------------------------------

export const AL_CHAT_TOPIC_ID = 'chat';

// -------------------------------------------------------
// Payloads
// -------------------------------------------------------

export type ChatTextPayload = Readonly<{
    chatMessageId: string;
    groupId: string;
    senderId: string;
    text: string;
    sentAtEpochMs: number;
}>;

// -------------------------------------------------------
// Route helpers
// -------------------------------------------------------

export function newALChatRoute(
    contextId: string,
    resourceId: string,
): ALRoute {
    return {
        topicId: AL_CHAT_TOPIC_ID,
        resourceId,
        contextId,
    };
}

// -------------------------------------------------------
// Payload helpers
// -------------------------------------------------------

export function newChatTextPayload(
    groupId: string,
    senderId: string,
    text: string,
): ChatTextPayload {
    return {
        chatMessageId: crypto.randomUUID(),
        groupId,
        senderId,
        text,
        sentAtEpochMs: Date.now(),
    };
}

// -------------------------------------------------------
// Message factories
// -------------------------------------------------------

/**
 * Group chat message.
 *
 * Convention:
 * - groupId === overlayId
 * - logical destination is multicast to the group
 * - route.contextId is groupId
 * - route.resourceId is the chat message id
 */
export function newALChatTextMulticastMessage(
    senderId: string,
    groupId: string,
    text: string,
    options?: Readonly<{
        membershipEpoch?: number;
        ttlHops?: number;
        ttlMs?: number;
        seq?: number;
        reliability?: 'best-effort' | 'at-least-once';
        ack?: 'none' | 'receiver' | 'all-logical-recipients' | 'group-leader';
        ownership?: 'shared' | 'exclusive';
        nextHopPeerIds?: readonly string[];
        overlayId?: string;
        fanoutLimit?: number;
    }>,
): ALMessage {
    const payload = newChatTextPayload(groupId, senderId, text);

    return newALMulticastMessage(
        senderId,
        newALChatRoute(groupId, payload.chatMessageId),
        groupId,
        AL_CHAT_TEXT_TYPE_ID,
        payload,
        {
            membershipEpoch: options?.membershipEpoch,
            ttlHops: options?.ttlHops,
            ttlMs: options?.ttlMs,
            seq: options?.seq,
            orderingKey: groupId,
            reliability: options?.reliability ?? 'at-least-once',
            ack: options?.ack ?? 'none',
            ownership: options?.ownership ?? 'shared',
            nextHopPeerIds: options?.nextHopPeerIds,
            overlayId: options?.overlayId ?? groupId,
            fanoutLimit: options?.fanoutLimit,
        },
    );
}