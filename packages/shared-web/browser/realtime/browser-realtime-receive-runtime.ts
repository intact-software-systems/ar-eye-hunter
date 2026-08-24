import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import type { RallarRealtimeHandler, RallarRealtimeMessage } from '@shared-web/browser/rallar-realtime-facade.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { QRtcPeerDto } from '@shared/services/WebRtcConnectionService.ts';

const RALLAR_REALTIME_LIFECYCLE_CALLBACK_ID = 'rallar:realtime:lifecycle';
type RallarRealtimeJsonValue = object | string | number | boolean | null;

export namespace BrowserRealtimeReceiveRuntime {
    export interface Input {
        readMiddleware(): ApiMiddleware | undefined;
    }

    export interface MessageInput {
        readonly peerId: string;
        readonly laneId: string;
        readonly data: MessageEvent['data'];
        readonly event: MessageEvent;
    }
}

/** Owns realtime lane subscriptions, inbound decoding, and peer callback lifetime. */
export class BrowserRealtimeReceiveRuntime {
    private readonly binaryListeners = new Map<string, Set<RallarRealtimeHandler<ArrayBuffer>>>();
    private readonly jsonListeners = new Map<string, Set<RallarRealtimeHandler<RallarRealtimeJsonValue>>>();
    private readonly input: BrowserRealtimeReceiveRuntime.Input;

    constructor(input: BrowserRealtimeReceiveRuntime.Input) {
        this.input = input;
    }

    onJson<T>(laneId: string, handler: RallarRealtimeHandler<T>): RallarUnsubscribe {
        const listeners = this.jsonListeners.get(laneId) ??
            new Set<RallarRealtimeHandler<RallarRealtimeJsonValue>>();
        listeners.add(handler as RallarRealtimeHandler<RallarRealtimeJsonValue>);
        this.jsonListeners.set(laneId, listeners);
        this.registerLaneCallbacks(laneId);
        return () => {
            listeners.delete(handler as RallarRealtimeHandler<RallarRealtimeJsonValue>);
            this.deleteLaneIfUnused(laneId);
        };
    }

    onBinary(
        laneId: string,
        handler: RallarRealtimeHandler<ArrayBuffer>
    ): RallarUnsubscribe {
        const listeners = this.binaryListeners.get(laneId) ??
            new Set<RallarRealtimeHandler<ArrayBuffer>>();
        listeners.add(handler);
        this.binaryListeners.set(laneId, listeners);
        this.registerLaneCallbacks(laneId);
        return () => {
            listeners.delete(handler);
            this.deleteLaneIfUnused(laneId);
        };
    }

    attachPeerLifecycle(ctx: ApiMiddleware): void {
        ctx.middleware.webRtcConnectionService.onRtcPeerLifecycleDo(
            RALLAR_REALTIME_LIFECYCLE_CALLBACK_ID,
            {
                onCreated: (peer) => this.registerCallbacksForPeer(peer),
                onDeleted: (peer) => this.removeCallbacksForPeer(peer)
            }
        );
    }

    detachPeerLifecycle(ctx = this.input.readMiddleware()): void {
        ctx?.middleware.webRtcConnectionService.removeRtcPeerLifecycleById(
            RALLAR_REALTIME_LIFECYCLE_CALLBACK_ID
        );
    }

    attachLaneCallbacks(): void {
        for (const laneId of this.laneIds()) {
            this.registerLaneCallbacks(laneId);
        }
    }

    detachLaneCallbacks(ctx = this.input.readMiddleware()): void {
        if (!ctx) {
            return;
        }
        for (const peerId of ctx.middleware.webRtcConnectionService.knownPeerIds()) {
            const peer = ctx.middleware.webRtcConnectionService.readPeer(peerId);
            if (peer) {
                this.removeCallbacksForPeer(peer);
            }
        }
    }

    private laneIds(): readonly string[] {
        return [...new Set([...this.jsonListeners.keys(), ...this.binaryListeners.keys()])];
    }

    private callbackId(laneId: string): string {
        return `rallar:realtime:${laneId}`;
    }

    private registerCallbacksForPeer(peer: QRtcPeerDto, laneId?: string): void {
        const selectedLaneIds = laneId ? [laneId] : this.laneIds();
        for (const currentLaneId of selectedLaneIds) {
            peer.channels.get(currentLaneId)?.onRawMessageDo(
                this.callbackId(currentLaneId),
                {
                    onMessage: async (data, event) =>
                        await this.dispatchMessage({
                            peerId: peer.peerId,
                            laneId: currentLaneId,
                            data,
                            event
                        })
                }
            );
        }
    }

    private registerLaneCallbacks(laneId: string): void {
        const ctx = this.input.readMiddleware();
        if (!ctx) {
            return;
        }
        for (const peerId of ctx.middleware.webRtcConnectionService.activePeerIds()) {
            const peer = ctx.middleware.webRtcConnectionService.readPeer(peerId);
            if (peer) {
                this.registerCallbacksForPeer(peer, laneId);
            }
        }
    }

    private removeCallbacksForPeer(peer: QRtcPeerDto): void {
        for (const laneId of this.laneIds()) {
            peer.channels.get(laneId)?.removeOnRawMessageCallbackById(
                this.callbackId(laneId)
            );
        }
    }

    private async dispatchMessage(input: BrowserRealtimeReceiveRuntime.MessageInput): Promise<void> {
        if (typeof input.data === 'string') {
            await this.dispatchJson(input);
            return;
        }
        await this.dispatchBinary(input);
    }

    private async dispatchJson(input: BrowserRealtimeReceiveRuntime.MessageInput): Promise<void> {
        const listeners = this.jsonListeners.get(input.laneId);
        if (!listeners || listeners.size === 0) {
            return;
        }
        let parsed: object | string | number | boolean | null;
        try {
            parsed = JSON.parse(input.data as string);
        }
        catch (error) {
            console.error('Error parsing Rallar realtime JSON message', error);
            return;
        }
        await notifyListeners(listeners, toRealtimeMessage(input, parsed));
    }

    private async dispatchBinary(input: BrowserRealtimeReceiveRuntime.MessageInput): Promise<void> {
        const listeners = this.binaryListeners.get(input.laneId);
        if (!listeners || listeners.size === 0) {
            return;
        }
        const bytes = await toArrayBuffer(input.data);
        if (bytes) {
            await notifyListeners(listeners, toRealtimeMessage(input, bytes));
        }
    }

    private deleteLaneIfUnused(laneId: string): void {
        if (this.jsonListeners.get(laneId)?.size === 0) {
            this.jsonListeners.delete(laneId);
        }
        if (this.binaryListeners.get(laneId)?.size === 0) {
            this.binaryListeners.delete(laneId);
        }
        if (this.jsonListeners.has(laneId) || this.binaryListeners.has(laneId)) {
            return;
        }
        const ctx = this.input.readMiddleware();
        for (const peerId of ctx?.middleware.webRtcConnectionService.knownPeerIds() ?? []) {
            ctx?.middleware.webRtcConnectionService.readPeer(peerId)?.channels.get(laneId)
                ?.removeOnRawMessageCallbackById(this.callbackId(laneId));
        }
    }
}

function toRealtimeMessage<T>(
    input: BrowserRealtimeReceiveRuntime.MessageInput,
    data: T
): RallarRealtimeMessage<T> {
    return {
        peerId: input.peerId,
        laneId: input.laneId,
        data,
        event: input.event,
        receivedAtEpochMs: Date.now()
    };
}

async function notifyListeners<T>(
    listeners: Set<RallarRealtimeHandler<T>>,
    message: RallarRealtimeMessage<T>
): Promise<void> {
    await Promise.all([...listeners].map(async (listener) => {
        try {
            await listener(message);
        }
        catch (error) {
            console.error('Error notifying Rallar realtime listener', error);
        }
    }));
}

async function toArrayBuffer(data: MessageEvent['data']): Promise<ArrayBuffer | undefined> {
    if (data instanceof ArrayBuffer) {
        return data;
    }
    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer;
    }
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
        return await data.arrayBuffer();
    }
    return undefined;
}
