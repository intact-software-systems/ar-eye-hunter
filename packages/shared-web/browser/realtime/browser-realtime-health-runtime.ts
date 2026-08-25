import type { ApiMiddleware } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import type {
    RallarRealtimeHealthOptions,
    RallarRealtimeLaneHealth
} from '@shared-web/browser/rallar-realtime-facade.ts';

export namespace BrowserRealtimeHealthRuntime {
    export interface Input {
        readMiddleware(): ApiMiddleware | undefined;
    }
}

/** Owns current realtime lane-health views. */
export class BrowserRealtimeHealthRuntime {
    private readonly input: BrowserRealtimeHealthRuntime.Input;

    public constructor(input: BrowserRealtimeHealthRuntime.Input) {
        this.input = input;
    }

    public read(
        options: RallarRealtimeHealthOptions = {}
    ): readonly RallarRealtimeLaneHealth[] {
        const context = this.input.readMiddleware();
        if (!context) {
            return [];
        }
        const peerIds = options.peerIds ??
            context.middleware.webRtcConnectionService.activePeerIds();
        return peerIds.flatMap((peerId) => {
            const peer = context.middleware.webRtcConnectionService.readPeer(peerId);
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
}
