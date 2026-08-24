import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import type {
    RallarRealtimeBinarySendInput,
    RallarRealtimeHandler,
    RallarRealtimeHealthOptions,
    RallarRealtimeJsonLane,
    RallarRealtimeJsonLaneSendOptions,
    RallarRealtimeJsonSendInput,
    RallarRealtimeLaneHealth,
    RallarRealtimeSendOptions,
    RallarRealtimeSendResult
} from '@shared-web/browser/rallar-realtime-facade.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { WebRtcPeerLaneOpenResult } from '@shared/services/WebRtcConnectionService.ts';
import type { RtcDataChannelSendOptions, RtcDataChannelSendResult } from '@shared/webrtc/QRtcDataChannel.ts';

export namespace BrowserRealtimeSendRuntime {
    export interface Input {
        connect(): Promise<ApiMiddleware>;
        readMiddleware(): ApiMiddleware | undefined;
        readSession(): AuthSession | undefined;
        readDefaultRoom(): string | GroupRef | undefined;
        readCurrentRoomSnapshot(): GroupSnapshot | undefined;
        findGroupSnapshot(room: string | GroupRef): GroupSnapshot | undefined;
        resolveLaneId(laneId?: string): string;
        resolveOpenTimeoutMs(openTimeoutMs?: number): number;
        onJson<T>(laneId: string, handler: RallarRealtimeHandler<T>): RallarUnsubscribe;
    }

    export interface LaneInput {
        readonly ctx: ApiMiddleware;
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
        const ctx = await this.input.connect();
        const laneId = this.input.resolveLaneId(input.laneId);
        return await Promise.all(
            this.resolvePeerIds(input).map(async (peerId) => {
                const laneOpen = await this.ensureLaneOpen({ ctx, peerId, laneId, sendOptions: input });
                return {
                    peerId,
                    laneId,
                    result: laneOpen.status === 'open' && laneOpen.channel
                        ? laneOpen.channel.sendJson(input.data, toDataChannelSendOptions(input))
                        : toClosedSendResult()
                };
            })
        );
    }

    async sendBinary(
        input: RallarRealtimeBinarySendInput
    ): Promise<readonly RallarRealtimeSendResult[]> {
        const ctx = await this.input.connect();
        const laneId = this.input.resolveLaneId(input.laneId);
        return await Promise.all(
            this.resolvePeerIds(input).map(async (peerId) => {
                const laneOpen = await this.ensureLaneOpen({ ctx, peerId, laneId, sendOptions: input });
                return {
                    peerId,
                    laneId,
                    result: laneOpen.status === 'open' && laneOpen.channel
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
                await this.sendJson<T>({ ...defaults, ...sendOptions, data }),
            on: (handler) => this.input.onJson<T>(laneId, handler)
        };
    }

    health(options: RallarRealtimeHealthOptions = {}): readonly RallarRealtimeLaneHealth[] {
        const ctx = this.input.readMiddleware();
        if (!ctx) {
            return [];
        }
        const peerIds = options.peerIds ?? ctx.middleware.webRtcConnectionService.activePeerIds();
        return peerIds.flatMap((peerId) => {
            const peer = ctx.middleware.webRtcConnectionService.readPeer(peerId);
            if (!peer) {
                return [];
            }
            const laneIds = options.laneIds ?? Array.from(peer.channels.keys());
            return laneIds.map((laneId) => ({
                peerId,
                laneId,
                channel: peer.channels.get(laneId)?.readHealth()
            }));
        });
    }

    private resolvePeerIds(input: RallarRealtimeSendOptions): readonly string[] {
        const sessionId = this.input.readSession()?.sessionId;
        if (input.peerIds) {
            return [...new Set(input.peerIds)].filter((peerId) => peerId !== sessionId);
        }
        const defaultRoom = this.input.readDefaultRoom();
        const room = input.roomRef
            ? this.input.findGroupSnapshot(input.roomRef)
            : input.roomId
            ? this.input.findGroupSnapshot(input.roomId)
            : defaultRoom
            ? this.input.findGroupSnapshot(defaultRoom)
            : this.input.readCurrentRoomSnapshot();
        return [
            ...new Set(
                (room?.activeSessions ?? [])
                    .map((activeSession) => activeSession.sessionId)
                    .filter((peerId) => peerId !== sessionId)
            )
        ];
    }

    private async ensureLaneOpen(input: BrowserRealtimeSendRuntime.LaneInput): Promise<WebRtcPeerLaneOpenResult> {
        return await input.ctx.middleware.webRtcConnectionService.ensurePeerLaneOpen(
            input.peerId,
            input.laneId,
            { timeoutMs: this.input.resolveOpenTimeoutMs(input.sendOptions.openTimeoutMs) }
        );
    }
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
