import {Hono} from "jsr:@hono/hono";
import * as metered from "./metered.ts";

type IceConfig = {
    readonly iceServers: readonly RTCIceServer[];
    readonly expiresAtEpochMs: number;
};

function toJsonResponse<T>(data: T, status = 200): Response {
    return Response.json(
        data,
        {
            status: status,
            headers: {'content-type': 'application/json'}
        }
    );
}

// simple in-memory cache to reduce calls during dev + bursts
let cache:
    | { iceServers: readonly RTCIceServer[]; expiresAtEpochMs: number }
    | { iceServers: readonly RTCIceServer[]; expiresAtEpochMs: number; _brand?: never }
    | undefined = undefined;

const CACHE_MS = 60_000; // 60s is plenty

export function init(app: Hono): void {
    app.get(
        'api/webrtc/ice',
        async (c) => {
            try {

                if (cache && cache.expiresAtEpochMs > Date.now()) {
                    return toJsonResponse<IceConfig>({
                        iceServers: cache.iceServers,
                        expiresAtEpochMs: cache.expiresAtEpochMs
                    });
                }

                const res = await metered.getIceCandidates()

                if (!res.ok) {
                    const txt = await res.text().catch(() => '');
                    return toJsonResponse(
                        {
                            error: `Metered ice fetch failed: ${res.status} ${txt}`
                        },
                        502
                    );
                }

                const iceServers = (await res.json()) as readonly RTCIceServer[];

                const expiresAtEpochMs = Date.now() + CACHE_MS;
                cache = {iceServers, expiresAtEpochMs};

                return toJsonResponse<IceConfig>({iceServers, expiresAtEpochMs});
            } catch (e) {
                return toJsonResponse({error: (e as Error).message}, 500);
            }
        }
    )
}