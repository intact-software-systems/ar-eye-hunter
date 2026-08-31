import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type {
    RallarRealtimeBinarySendInput,
    RallarRealtimeHandler,
    RallarRealtimeJsonLane,
    RallarRealtimeJsonLaneSendOptions,
    RallarRealtimeJsonSendInput,
    RallarRealtimeSendOptions,
    RallarRealtimeSendResult
} from '@shared-web/browser/rallar-realtime-facade.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { BrowserRoomTransportTarget } from '@shared-web/browser/rooms/room-group-state-translation.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import type { RtcDataChannelSendOptions, RtcDataChannelSendResult } from '@shared/webrtc/qrtc-data-channel.ts';

export namespace BrowserRealtimeSendRuntime {
    export interface Input {
        connect(): Promise<ApiMiddleware>;
        readSession(): AuthSession | undefined;
        readDefaultRoom(): string | GroupRef | undefined;
        readCurrentRoomRef(): GroupRef | undefined;
        resolveRoomTransportTarget(room: string | GroupRef): BrowserRoomTransportTarget;
        resolveRoomRef(room: string | GroupRef): GroupRef | undefined;
        resolveLaneId(laneId?: string): string;
        resolveOpenTimeoutMs(openTimeoutMs?: number): number;
        onJson<T>(laneId: string, handler: RallarRealtimeHandler<T>): RallarUnsubscribe;
    }

    export interface RoomSelection {
        readonly scoped: boolean;
        readonly roomRef: GroupRef | undefined;
    }

    export interface Target {
        readonly roomRef: GroupRef | undefined;
        readonly peerIds: readonly string[];
    }

    export interface LaneInput {
        readonly context: ApiMiddleware;
        readonly peerId: string;
        readonly laneId: string;
        readonly sendOptions: RallarRealtimeSendOptions;
    }
}

/** Owns realtime peer selection, RTC lane opening, and JSON/binary sends. */
export class BrowserRealtimeSendRuntime {
    private readonly input: BrowserRealtimeSendRuntime.Input;

    constructor(input: BrowserRealtimeSendRuntime.Input) {
        this.input = input;
    }

    async sendJson<T>(
        input: RallarRealtimeJsonSendInput<T>
    ): Promise<readonly RallarRealtimeSendResult[]> {
        const room = this.resolveRoom(input);
        const context = await this.input.connect();
        const laneId = this.input.resolveLaneId(input.laneId);
        const target = this.resolveTarget(input, room);
        return await Promise.all(
            target.peerIds.map(async (peerId): Promise<RallarRealtimeSendResult> => {
                const laneOpen = await this.ensureLaneOpen({ context, peerId, laneId, sendOptions: input });
                return {
                    peerId,
                    laneId,
                    result: !this.isCurrentTarget(target, peerId)
                        ? {
                            status: 'closed',
                            reason: 'Room realtime target is no longer authorized',
                            bufferedAmount: 0
                        }
                        : laneOpen.status === 'open' && laneOpen.channel
                        ? laneOpen.channel.sendJson(input.data, toDataChannelSendOptions(input))
                        : toClosedSendResult()
                };
            })
        );
    }

    async sendBinary(
        input: RallarRealtimeBinarySendInput
    ): Promise<readonly RallarRealtimeSendResult[]> {
        const room = this.resolveRoom(input);
        const context = await this.input.connect();
        const laneId = this.input.resolveLaneId(input.laneId);
        const target = this.resolveTarget(input, room);
        return await Promise.all(
            target.peerIds.map(async (peerId): Promise<RallarRealtimeSendResult> => {
                const laneOpen = await this.ensureLaneOpen({ context, peerId, laneId, sendOptions: input });
                return {
                    peerId,
                    laneId,
                    result: !this.isCurrentTarget(target, peerId)
                        ? {
                            status: 'closed',
                            reason: 'Room realtime target is no longer authorized',
                            bufferedAmount: 0
                        }
                        : laneOpen.status === 'open' && laneOpen.channel
                        ? laneOpen.channel.sendBinary(input.data, toDataChannelSendOptions(input))
                        : toClosedSendResult()
                };
            })
        );
    }

    createJsonLane<T>(defaults: RallarRealtimeSendOptions): RallarRealtimeJsonLane<T> {
        const laneId = this.input.resolveLaneId(defaults.laneId);
        return {
            send: async (data, sendOptions: RallarRealtimeJsonLaneSendOptions<T> = {}) =>
                await this.sendJson<T>({
                    ...defaults,
                    ...sendOptions,
                    roomRef: sendOptions.roomId !== undefined && sendOptions.roomRef === undefined
                        ? undefined
                        : sendOptions.roomRef ?? defaults.roomRef,
                    data
                }),
            on: (handler) => this.input.onJson<T>(laneId, handler)
        };
    }

    private resolveRoom(input: RallarRealtimeSendOptions): BrowserRealtimeSendRuntime.RoomSelection {
        const room = input.roomRef ?? input.roomId ?? (input.peerIds === undefined
            ? this.input.readDefaultRoom() ?? this.input.readCurrentRoomRef()
            : undefined);
        return {
            scoped: room !== undefined,
            roomRef: room === undefined ? undefined : this.input.resolveRoomRef(room)
        };
    }

    private resolveTarget(
        input: RallarRealtimeSendOptions,
        room: BrowserRealtimeSendRuntime.RoomSelection
    ): BrowserRealtimeSendRuntime.Target {
        const sessionId = this.input.readSession()?.sessionId;
        const explicitPeerIds = input.peerIds === undefined
            ? undefined
            : [...new Set(input.peerIds)].filter((peerId) => peerId !== sessionId);
        const roomRef = room.roomRef;
        if (!room.scoped) {
            return { roomRef, peerIds: explicitPeerIds ?? [] };
        }
        if (!roomRef) {
            return { roomRef, peerIds: [] };
        }
        const authority = this.input.resolveRoomTransportTarget(roomRef);
        return {
            roomRef,
            peerIds: authority.transportState === 'halted'
                ? []
                : (explicitPeerIds ?? authority.peerIds).filter((peerId) => authority.peerIds.includes(peerId))
        };
    }

    private isCurrentTarget(target: BrowserRealtimeSendRuntime.Target, peerId: string): boolean {
        if (!target.roomRef) {
            return true;
        }
        const authority = this.input.resolveRoomTransportTarget(target.roomRef);
        return authority.transportState !== 'halted' && authority.peerIds.includes(peerId);
    }

    private async ensureLaneOpen(
        input: BrowserRealtimeSendRuntime.LaneInput
    ): Promise<WebRtcConnectionService.PeerLaneOpenResult> {
        return await input.context.middleware.webRtcConnectionService.ensurePeerLaneOpen(
            input.peerId,
            input.laneId,
            { timeoutMs: this.input.resolveOpenTimeoutMs(input.sendOptions.openTimeoutMs) }
        );
    }
}

export function isAcceptedRealtimeSendResult(
    result: RallarRealtimeSendResult
): boolean {
    return result.result.status === 'sent' || result.result.status === 'queued' ||
        result.result.status === 'replaced';
}

function toDataChannelSendOptions(input: RallarRealtimeSendOptions): RtcDataChannelSendOptions {
    return { key: input.key, maxAgeMs: input.maxAgeMs, now: input.now };
}

function toClosedSendResult(): RtcDataChannelSendResult {
    return {
        status: 'closed',
        reason: 'Realtime lane not connected',
        bufferedAmount: 0
    };
}
