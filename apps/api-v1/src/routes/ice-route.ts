import { Hono } from 'jsr:@hono/hono';
import * as metered from '../integration/metered-api.ts';
import { IceConfig } from '@shared/api/api-config.ts';
import { requireApiAuthSession, toAuthErrorResponse } from '../services/request-auth-service.ts';
import { readRateLimiter } from '@shared-server/http/rate-limit-service.ts';
import { RateLimiter, RateLimiterPolicy } from '@shared/resilience/Resilience.ts';
import { LoanedValue } from '@shared/cache/LoanedValue.ts';

const ICE_RATE_LIMIT = new RateLimiterPolicy(60_000, 20);
const CACHE_MS = 300_000;

class MeteredIceFetchError extends Error {
    public constructor(
        public readonly status: number,
        public readonly body: string,
    ) {
        super(`Metered ice fetch failed: ${status} ${body}`);
    }
}

function toJsonResponse<T>(data: T, status = 200): Response {
    return Response.json(
        data,
        {
            status: status,
            headers: { 'content-type': 'application/json' },
        },
    );
}

const iceConfigCache = new LoanedValue<IceConfig>(
    readFreshIceConfig,
    {
        ttlMs: CACHE_MS,
        isValid: (value) => value.expiresAtEpochMs > Date.now(),
    },
);

export function init(app: Hono): void {
    app.get(
        '/api/webrtc/ice',
        async (c) => {
            try {
                const authSession = await requireApiAuthSession(c.req);

                return await RateLimiter.tryToExecuteOrDefault<Response>(
                    readRateLimiter('webrtc-ice', authSession.clientId, ICE_RATE_LIMIT),
                    async () => await readIceConfig(),
                    c.json({ error: 'Too many ICE configuration requests' }, 429),
                );
            } catch (e) {
                return toIceRouteErrorResponse(c, e);
            }
        },
    );
}

async function readIceConfig(): Promise<Response> {
    try {
        return toJsonResponse<IceConfig>(await iceConfigCache.get());
    } catch (error) {
        if (error instanceof MeteredIceFetchError) {
            return toJsonResponse({ error: error.message }, 502);
        }

        throw error;
    }
}

async function readFreshIceConfig(): Promise<IceConfig> {
    let res: Response;
    try {
        res = await metered.getIceCandidates();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new MeteredIceFetchError(0, message);
    }

    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new MeteredIceFetchError(res.status, txt);
    }

    const iceServers = (await res.json()) as readonly RTCIceServer[];
    const expiresAtEpochMs = Date.now() + CACHE_MS;

    return { iceServers, expiresAtEpochMs };
}

function toIceRouteErrorResponse(
    c: {
        json(value: unknown, status?: number): Response;
    },
    error: unknown,
): Response {
    if (error instanceof Error && error.message.startsWith('Unauthorized:')) {
        return toAuthErrorResponse(c, error);
    }

    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 500);
}
