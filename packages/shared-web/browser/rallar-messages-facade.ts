import type { RallarMessageSelectorInput } from '@shared-web/browser/rallar-message-selectors.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { ALAckMode, ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALOutboundEnqueueStatus } from '@shared/alm/ALOutboundMessageRuntime.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

export type RallarTypedMessageSendStrategy =
    | 'ws'
    | 'rtc'
    | 'realtime'
    | 'ws-then-rtc'
    | 'rtc-with-ws-fallback';

export type RallarMessageTransport = 'rtc' | 'ws' | 'replay';

export type RallarMessage<T = unknown> = Readonly<{
    transport: RallarMessageTransport;
    typeId: string;
    topicId: string;
    contextId: string;
    resourceId: string;
    roomId?: string;
    senderId: string;
    payload: T;
    raw: ALMessage;
    receivedAtEpochMs: number;
}>;

export type RallarMessageHandler<T = unknown> = (
    message: RallarMessage<T>
) => void | Promise<void>;

export type RallarStateEventListener<TEvent> = (
    event: TEvent,
    message: RallarMessage<TEvent>
) => void | Promise<void>;

export type RallarMessageSendBase<T> = Readonly<{
    typeId: string;
    payload: T;
    topicId?: string;
    contextId?: string;
    resourceId?: string;
    ttlHops?: number;
    ttlMs?: number;
    reliability?: 'best-effort' | 'at-least-once';
    ack?: ALAckMode;
    ownership?: 'shared' | 'exclusive';
}>;

export type RallarRtcSendInput<T> =
    & RallarMessageSendBase<T>
    & Readonly<{
        roomId?: string;
        roomRef?: GroupRef;
        membershipEpoch?: number;
        minSnapshotVersion?: number;
        seq?: number;
        orderingKey?: string;
        nextHopPeerIds?: readonly string[];
        overlayId?: string;
        fanoutLimit?: number;
    }>;

export type RallarWsSendInput<T> =
    & RallarMessageSendBase<T>
    & Readonly<{
        scope?: 'room' | 'world' | 'all';
        roomId?: string;
        roomRef?: GroupRef;
        minSnapshotVersion?: number;
        exceptPeerIds?: readonly string[];
    }>;

export type RallarMessageSendStatus = ALOutboundEnqueueStatus;

export type RallarMessageSendResult = Readonly<{
    transport: RallarMessageTransport;
    status: RallarMessageSendStatus;
    message: ALMessage;
    entry?: ResourceEntry;
    entries: readonly ResourceEntry[];
    reason?: string;
}>;

export type RallarMessageLane<TSendInput, TSelector = string> = Readonly<{
    send<T>(
        input: TSendInput & RallarMessageSendBase<T>
    ): Promise<RallarMessageSendResult>;
    onMessage<T = unknown>(
        selector: TSelector,
        handler: RallarMessageHandler<T>
    ): RallarUnsubscribe;
}>;

export type RallarTypedMessageChannelDefinition = Readonly<{
    topicId?: string;
    typeId: string;
}>;

export type RallarTypedPayloadHandler<T> = (
    payload: T,
    message: RallarMessage<T>
) => void | Promise<void>;

export type RallarTypedRtcSendOptions<T> = Omit<RallarRtcSendInput<T>, 'topicId' | 'typeId' | 'payload'>;

export type RallarTypedWsSendOptions<T> = Omit<RallarWsSendInput<T>, 'topicId' | 'typeId' | 'payload'>;

export type RallarTypedMessageSendOptions<T> =
    & Partial<RallarTypedRtcSendOptions<T>>
    & Partial<RallarTypedWsSendOptions<T>>
    & Readonly<{
        strategy?: RallarTypedMessageSendStrategy;
    }>;

export type RallarTypedMessageChannel<T> = Readonly<{
    send(
        payload: T,
        options?: RallarTypedMessageSendOptions<T>
    ): Promise<RallarMessageSendResult>;
    sendRtc(
        payload: T,
        options?: RallarTypedRtcSendOptions<T>
    ): Promise<RallarMessageSendResult>;
    sendWs(
        payload: T,
        options?: RallarTypedWsSendOptions<T>
    ): Promise<RallarMessageSendResult>;
    onRtc(handler: RallarTypedPayloadHandler<T>): RallarUnsubscribe;
    onWs(handler: RallarTypedPayloadHandler<T>): RallarUnsubscribe;
}>;

export type RallarRoomMessageChannelDefinition =
    & RallarTypedMessageChannelDefinition
    & Readonly<{
        roomId?: string;
        roomRef?: GroupRef;
    }>;

export type RallarRoomMessageChannel<T> = RallarTypedMessageChannel<T>;

export type RallarMessagesFacade = Readonly<{
    rtc: RallarMessageLane<RallarRtcSendInput<unknown>, RallarMessageSelectorInput>;
    ws: RallarMessageLane<RallarWsSendInput<unknown>, RallarMessageSelectorInput>;
    channel<T>(
        definition: RallarTypedMessageChannelDefinition
    ): RallarTypedMessageChannel<T>;
    room<T>(
        definition: RallarRoomMessageChannelDefinition
    ): RallarRoomMessageChannel<T>;
}>;

export type CreateRallarMessagesFacadeOptions = RallarMessagesFacade;

export function createRallarMessagesFacade(
    operations: CreateRallarMessagesFacadeOptions
): RallarMessagesFacade {
    return {
        rtc: {
            send: async (input) => await operations.rtc.send(input),
            onMessage: (selector, handler) => operations.rtc.onMessage(selector, handler)
        },
        ws: {
            send: async (input) => await operations.ws.send(input),
            onMessage: (selector, handler) => operations.ws.onMessage(selector, handler)
        },
        channel: <T>(
            definition: RallarTypedMessageChannelDefinition
        ): RallarTypedMessageChannel<T> => operations.channel<T>(definition),
        room: <T>(
            definition: RallarRoomMessageChannelDefinition
        ): RallarRoomMessageChannel<T> => operations.room<T>(definition)
    };
}
