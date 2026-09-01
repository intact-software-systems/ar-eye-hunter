import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type {
    RallarRealtimeHandler,
    RallarRealtimeJsonSendInput,
    RallarRealtimeSendOptions,
    RallarRealtimeSendResult,
    RallarRoomRealtimeJsonChannel,
    RallarRoomRealtimeJsonDefaults,
    RallarRoomRealtimeJsonSendOptions,
    RallarRoomRealtimeSendResult,
    RallarRoomRealtimeSendStatus,
    RallarRoomRealtimeTransportOptions
} from '@shared-web/browser/rallar-realtime-facade.ts';
import type {
    RallarRoomTransportStatus,
    RallarRtcFacade,
    RallarRtcRoomLaneWaitResult
} from '@shared-web/browser/rallar-rtc-facade.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import { isAcceptedRealtimeSendResult } from '@shared-web/browser/realtime/browser-realtime-send-runtime.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

export namespace BrowserRoomRealtimeRuntime {
    export interface Input {
        connect(): Promise<ApiMiddleware>;
        readDefaultRoom(): string | GroupRef | undefined;
        readCurrentRoomRef(): GroupRef | undefined;
        resolveRoomRef(room: string | GroupRef): GroupRef | undefined;
        resolveLaneId(laneId?: string): string;
        readonly rtc: RallarRtcFacade;
        sendJson<T>(input: RallarRealtimeJsonSendInput<T>): Promise<readonly RallarRealtimeSendResult[]>;
        onJson<T>(laneId: string, handler: RallarRealtimeHandler<T>): RallarUnsubscribe;
    }

    export interface TargetInput<T> {
        readonly roomRef: GroupRef;
        readonly laneId: string;
        readonly defaults: RallarRoomRealtimeJsonDefaults;
        readonly sendOptions: RallarRoomRealtimeJsonSendOptions<T>;
    }

    export interface Target {
        readonly laneId: string;
        readonly desiredPeerIds: readonly string[];
        readonly readyPeerIds: readonly string[];
        readonly readiness?: RallarRtcRoomLaneWaitResult;
        readonly transportStatus: RallarRoomTransportStatus;
    }
}

/** Owns room realtime readiness, transport selection, and room channels. */
export class BrowserRoomRealtimeRuntime {
    private readonly input: BrowserRoomRealtimeRuntime.Input;

    constructor(input: BrowserRoomRealtimeRuntime.Input) {
        this.input = input;
    }

    create<T>(defaults: RallarRoomRealtimeJsonDefaults): RallarRoomRealtimeJsonChannel<T> {
        const laneId = this.input.resolveLaneId(defaults.laneId);
        return {
            send: async (data, options: RallarRoomRealtimeJsonSendOptions<T> = {}) =>
                await this.send(defaults, data, options),
            on: (handler) => this.input.onJson<T>(laneId, handler),
            status: (options: RallarRoomRealtimeTransportOptions = {}) => {
                const room = this.requireRoom(defaults, options, 'read room realtime status');
                return this.input.rtc.roomStatus(room, {
                    ...options,
                    laneId: this.input.resolveLaneId(options.laneId ?? defaults.laneId)
                });
            },
            wait: async (options: RallarRoomRealtimeTransportOptions = {}) => {
                const room = this.requireRoom(defaults, options, 'wait for room realtime');
                return await this.input.rtc.waitForRoom(room, {
                    ...options,
                    laneId: this.input.resolveLaneId(options.laneId ?? defaults.laneId),
                    connect: options.connect ?? defaults.connect ?? true,
                    timeoutMs: options.timeoutMs ?? defaults.waitTimeoutMs,
                    minReadyPeers: options.minReadyPeers ?? defaults.minReadyPeers
                });
            }
        };
    }

    private async send<T>(
        defaults: RallarRoomRealtimeJsonDefaults,
        data: T,
        sendOptions: RallarRoomRealtimeJsonSendOptions<T>
    ): Promise<RallarRoomRealtimeSendResult> {
        const laneId = this.input.resolveLaneId(sendOptions.laneId ?? defaults.laneId);
        const room = this.resolveRoom(defaults, sendOptions);
        if (!room) {
            return noRoomResult(laneId);
        }
        const roomRef = this.input.resolveRoomRef(room);
        if (!roomRef) {
            return { ...noRoomResult(laneId), reason: 'Cannot resolve room realtime identity.' };
        }
        const target = await this.readTarget({ roomRef, laneId, defaults, sendOptions });
        const unavailable = toUnavailableRoomResult(target);
        if (unavailable) {
            return unavailable;
        }
        const results = await this.input.sendJson<T>({
            ...toRealtimeSendOptions(defaults, sendOptions),
            laneId,
            roomRef,
            peerIds: target.readyPeerIds,
            data
        });
        const transportStatus = this.input.rtc.roomStatus(roomRef, { laneId });
        const status = toRoomSendStatus(target.desiredPeerIds, target.readyPeerIds, results);
        return {
            transport: 'rtc',
            status: status === 'failed' && transportStatus.rtc.state === 'halted' ? 'halted' : status,
            laneId,
            roomId: roomRef.groupId,
            roomRef,
            peerIds: target.readyPeerIds,
            desiredPeerIds: target.desiredPeerIds,
            readiness: target.readiness,
            transportStatus,
            results
        };
    }

    private async readTarget<T>(
        input: BrowserRoomRealtimeRuntime.TargetInput<T>
    ): Promise<BrowserRoomRealtimeRuntime.Target> {
        await this.input.connect();
        let transportStatus = this.input.rtc.roomStatus(input.roomRef, {
            laneId: input.laneId,
            minReadyPeers: input.sendOptions.minReadyPeers ?? input.defaults.minReadyPeers
        });
        let readiness: RallarRtcRoomLaneWaitResult | undefined;
        let readyPeerIds = transportStatus.rtc.readyPeerIds;
        const waitForReady = input.sendOptions.waitForReady ?? input.defaults.waitForReady ?? true;
        if (
            transportStatus.rtc.state !== 'halted' &&
            readyPeerIds.length === 0 &&
            waitForReady
        ) {
            readiness = await this.input.rtc.waitForRoomLane(input.roomRef, input.laneId, {
                connect: input.sendOptions.connect ?? input.defaults.connect ?? true,
                timeoutMs: input.sendOptions.waitTimeoutMs ?? input.defaults.waitTimeoutMs ??
                    input.sendOptions.openTimeoutMs ?? input.defaults.openTimeoutMs,
                signal: input.sendOptions.signal,
                roomRef: input.roomRef
            });
            readyPeerIds = uniquePeerIds(readiness.ready.map((ready) => ready.peerId));
            transportStatus = this.input.rtc.roomStatus(input.roomRef, {
                laneId: input.laneId,
                minReadyPeers: input.sendOptions.minReadyPeers ?? input.defaults.minReadyPeers
            });
            readyPeerIds = reauthorizeReadyPeerIds(readyPeerIds, transportStatus);
        }
        return {
            laneId: input.laneId,
            desiredPeerIds: transportStatus.rtc.desiredPeerIds,
            readyPeerIds,
            readiness,
            transportStatus
        };
    }

    private resolveRoom(
        defaults: RallarRoomRealtimeJsonDefaults,
        options: RallarRoomRealtimeTransportOptions
    ): string | GroupRef | undefined {
        return options.roomRef ?? options.roomId ?? defaults.roomRef ?? defaults.roomId ??
            this.input.readDefaultRoom() ?? this.input.readCurrentRoomRef();
    }

    private requireRoom(
        defaults: RallarRoomRealtimeJsonDefaults,
        options: RallarRoomRealtimeTransportOptions,
        operation: string
    ): string | GroupRef {
        const room = this.resolveRoom(defaults, options);
        if (!room) {
            throw new Error(`Cannot ${operation} without a room.`);
        }
        return room;
    }
}

function reauthorizeReadyPeerIds(
    candidatePeerIds: readonly string[],
    transportStatus: RallarRoomTransportStatus
): readonly string[] {
    const desiredPeerIds = new Set(transportStatus.rtc.desiredPeerIds);
    const readyPeerIds = new Set(transportStatus.rtc.readyPeerIds);
    return candidatePeerIds.filter((peerId) => desiredPeerIds.has(peerId) && readyPeerIds.has(peerId));
}

function noRoomResult(laneId: string): RallarRoomRealtimeSendResult {
    return {
        transport: 'rtc',
        status: 'no-targets',
        laneId,
        peerIds: [],
        desiredPeerIds: [],
        results: [],
        reason: 'Cannot send room realtime payload without a room.'
    };
}

function toUnavailableRoomResult(
    target: BrowserRoomRealtimeRuntime.Target
): RallarRoomRealtimeSendResult | undefined {
    const common: Omit<RallarRoomRealtimeSendResult, 'status'> = {
        transport: 'rtc',
        laneId: target.laneId,
        roomId: target.transportStatus.roomId,
        roomRef: target.transportStatus.roomRef,
        peerIds: [],
        desiredPeerIds: target.desiredPeerIds,
        readiness: target.readiness,
        transportStatus: target.transportStatus,
        results: []
    };
    if (target.transportStatus.rtc.state === 'halted') {
        return {
            ...common,
            status: 'halted',
            reason: target.transportStatus.rtc.reason ??
                'Room realtime transport is halted.'
        };
    }
    if (target.desiredPeerIds.length === 0) {
        return { ...common, status: 'no-targets', reason: 'Room has no RTC peer targets.' };
    }
    if (target.readyPeerIds.length === 0) {
        return {
            ...common,
            status: 'not-ready',
            reason: target.readiness?.status
                ? `Room RTC wait ended with ${target.readiness.status}.`
                : 'Room RTC has no ready peers.'
        };
    }
    return undefined;
}

function toRealtimeSendOptions(
    defaults: RallarRealtimeSendOptions,
    options: RallarRealtimeSendOptions
): RallarRealtimeSendOptions {
    return {
        key: options.key ?? defaults.key,
        maxAgeMs: options.maxAgeMs ?? defaults.maxAgeMs,
        now: options.now ?? defaults.now,
        openTimeoutMs: options.openTimeoutMs ?? defaults.openTimeoutMs
    };
}

function toRoomSendStatus(
    desiredPeerIds: readonly string[],
    peerIds: readonly string[],
    results: readonly RallarRealtimeSendResult[]
): RallarRoomRealtimeSendStatus {
    if (desiredPeerIds.length === 0) {
        return 'no-targets';
    }
    if (peerIds.length === 0) {
        return 'not-ready';
    }
    const sentCount = results.filter(isAcceptedRealtimeSendResult).length;
    if (sentCount === 0) {
        return 'failed';
    }
    return sentCount >= desiredPeerIds.length ? 'sent' : 'partial';
}

function uniquePeerIds(peerIds: readonly string[]): readonly string[] {
    return [...new Set(peerIds)];
}
