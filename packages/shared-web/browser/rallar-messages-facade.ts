import type {
    RallarMessageLane,
    RallarMessageSelectorInput,
    RallarRoomMessageChannel,
    RallarRoomMessageChannelDefinition,
    RallarRtcSendInput,
    RallarTypedMessageChannel,
    RallarTypedMessageChannelDefinition,
    RallarWsSendInput,
} from '@shared-web/browser/rallar.ts';

export type RallarMessagesFacade = Readonly<{
    rtc: RallarMessageLane<
        RallarRtcSendInput<unknown>,
        RallarMessageSelectorInput
    >;
    ws: RallarMessageLane<
        RallarWsSendInput<unknown>,
        RallarMessageSelectorInput
    >;
    channel<T>(
        definition: RallarTypedMessageChannelDefinition,
    ): RallarTypedMessageChannel<T>;
    room<T>(
        definition: RallarRoomMessageChannelDefinition,
    ): RallarRoomMessageChannel<T>;
}>;

export type CreateRallarMessagesFacadeOptions = RallarMessagesFacade;

export function createRallarMessagesFacade(
    operations: CreateRallarMessagesFacadeOptions,
): RallarMessagesFacade {
    return {
        rtc: {
            send: async (input) => await operations.rtc.send(input),
            onMessage: (selector, handler) =>
                operations.rtc.onMessage(selector, handler),
        },
        ws: {
            send: async (input) => await operations.ws.send(input),
            onMessage: (selector, handler) =>
                operations.ws.onMessage(selector, handler),
        },
        channel: <T>(
            definition: RallarTypedMessageChannelDefinition,
        ): RallarTypedMessageChannel<T> =>
            operations.channel<T>(definition),
        room: <T>(
            definition: RallarRoomMessageChannelDefinition,
        ): RallarRoomMessageChannel<T> =>
            operations.room<T>(definition),
    };
}
