import type {
    RallarRealtimeBinarySendInput,
    RallarRealtimeHandler,
    RallarRealtimeHealthOptions,
    RallarRealtimeJsonLane,
    RallarRealtimeJsonLaneDefaults,
    RallarRealtimeJsonSendInput,
    RallarRealtimeLaneHealth,
    RallarRealtimeSendResult,
    RallarRoomRealtimeJsonChannel,
    RallarRoomRealtimeJsonDefaults,
    RallarUnsubscribe,
} from '@shared-web/browser/rallar.ts';

export type RallarRealtimeFacade = Readonly<{
    sendJson<T>(
        input: RallarRealtimeJsonSendInput<T>,
    ): Promise<readonly RallarRealtimeSendResult[]>;
    sendBinary(
        input: RallarRealtimeBinarySendInput,
    ): Promise<readonly RallarRealtimeSendResult[]>;
    onJson<T = unknown>(
        laneId: string,
        handler: RallarRealtimeHandler<T>,
    ): RallarUnsubscribe;
    onBinary(
        laneId: string,
        handler: RallarRealtimeHandler<ArrayBuffer>,
    ): RallarUnsubscribe;
    json<T>(
        defaults?: RallarRealtimeJsonLaneDefaults,
    ): RallarRealtimeJsonLane<T>;
    room<T>(
        defaults?: RallarRoomRealtimeJsonDefaults,
    ): RallarRoomRealtimeJsonChannel<T>;
    health(
        options?: RallarRealtimeHealthOptions,
    ): readonly RallarRealtimeLaneHealth[];
}>;

export type CreateRallarRealtimeFacadeOptions = RallarRealtimeFacade;

export function createRallarRealtimeFacade(
    operations: CreateRallarRealtimeFacadeOptions,
): RallarRealtimeFacade {
    return {
        sendJson: async <T>(
            input: RallarRealtimeJsonSendInput<T>,
        ): Promise<readonly RallarRealtimeSendResult[]> =>
            await operations.sendJson(input),
        sendBinary: async (
            input: RallarRealtimeBinarySendInput,
        ): Promise<readonly RallarRealtimeSendResult[]> =>
            await operations.sendBinary(input),
        onJson: <T = unknown>(
            laneId: string,
            handler: RallarRealtimeHandler<T>,
        ): RallarUnsubscribe => operations.onJson<T>(laneId, handler),
        onBinary: (
            laneId: string,
            handler: RallarRealtimeHandler<ArrayBuffer>,
        ): RallarUnsubscribe => operations.onBinary(laneId, handler),
        json: <T>(
            defaults: RallarRealtimeJsonLaneDefaults = {},
        ): RallarRealtimeJsonLane<T> => operations.json<T>(defaults),
        room: <T>(
            defaults: RallarRoomRealtimeJsonDefaults = {},
        ): RallarRoomRealtimeJsonChannel<T> => operations.room<T>(defaults),
        health: (
            options: RallarRealtimeHealthOptions = {},
        ): readonly RallarRealtimeLaneHealth[] => operations.health(options),
    };
}
