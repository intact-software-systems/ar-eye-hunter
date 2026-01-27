import type { Route } from 'jsr:@std/http/unstable-route';

type IceConfig = {
    readonly iceServers: readonly RTCIceServer[];
    readonly expiresAtEpochMs: number;
};

function json<T>(data: T, status = 200): Response {
    return Response.json(data, { status, headers: { 'content-type': 'application/json' } });
}

function mustEnv(name: string): string {
    const v = Deno.env.get(name);
    if (!v || v.length === 0) throw new Error(`Missing env var: ${name}`);
    return v;
}

// simple in-memory cache to reduce calls during dev + bursts
let cache:
    | { iceServers: readonly RTCIceServer[]; expiresAtEpochMs: number }
    | { iceServers: readonly RTCIceServer[]; expiresAtEpochMs: number; _brand?: never }
    | undefined = undefined;

const CACHE_MS = 60_000; // 60s is plenty

export function iceRoutes(): Route[] {
    return [
        {
            method: 'GET',
            pattern: new URLPattern({ pathname: '/api/webrtc/ice' }),
            handler: async () => {
                try {
                    const now = Date.now();
                    if (cache && cache.expiresAtEpochMs > now) {
                        return json<IceConfig>({ iceServers: cache.iceServers, expiresAtEpochMs: cache.expiresAtEpochMs });
                    }

                    const appName = mustEnv('METERED_APP_NAME');
                    const apiKey = mustEnv('METERED_API_KEY');
                    const region = Deno.env.get('METERED_REGION') ?? '';

                    // Metered docs:
                    // GET https://<appname>.metered.live/api/v1/turn/credentials?apiKey=...(&region=...)
                    // Returns an array of iceServers entries (stun/turn urls + username/credential).  [oai_citation:1‡Metered](https://www.metered.ca/docs/turn-rest-api/get-credential/)
                    const url = new URL(`https://${appName}.metered.live/api/v1/turn/credentials`);
                    url.searchParams.set('apiKey', apiKey);
                    if (region.length > 0) url.searchParams.set('region', region);

                    const res = await fetch(url.toString(), { method: 'GET' });
                    if (!res.ok) {
                        const txt = await res.text().catch(() => '');
                        return json({ error: `Metered ice fetch failed: ${res.status} ${txt}` }, 502);
                    }

                    const iceServers = (await res.json()) as readonly RTCIceServer[];

                    const expiresAtEpochMs = now + CACHE_MS;
                    cache = { iceServers, expiresAtEpochMs };

                    return json<IceConfig>({ iceServers, expiresAtEpochMs });
                } catch (e) {
                    return json({ error: (e as Error).message }, 500);
                }
            },
        },
    ];
}