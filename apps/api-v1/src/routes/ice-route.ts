import { readRateLimiter } from '@shared-server/http/rate-limit-service.ts';
import { IceConfig } from '@shared/api/api-config.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { LoanedValue } from '@shared/cache/LoanedValue.ts';
import { RateLimiter, RateLimiterPolicy } from '@shared/resilience/Resilience.ts';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import type { ApiV1IceConfiguration, ApiV1MeteredIceConfiguration } from '../configuration/api-v1-configuration.ts';
import { getMeteredIceCandidates } from '../services/get-metered-ice-candidates.ts';
import { toAuthErrorResponse } from '../services/request-auth-service.ts';

class MeteredIceFetchError extends Error {
    public readonly status: number;
    public readonly body: string;

    public constructor(
        status: number,
        body: string
    ) {
        super(`Metered ice fetch failed: ${status} ${body}`);
        this.status = status;
        this.body = body;
    }
}

function toJsonResponse<T>(data: T, status = 200): Response {
    return Response.json(
        data,
        {
            status: status,
            headers: { 'content-type': 'application/json' }
        }
    );
}

export interface RegisterIceRoutesInput {
    readonly requireApiAuthSession: (
        request: Readonly<{ header(name: string): string | undefined; }>
    ) => Promise<AuthSession>;
    readonly configuration: ApiV1IceConfiguration;
    readonly nowEpochMs: () => number;
    readonly readMeteredIceCandidates?: (
        configuration: ApiV1MeteredIceConfiguration
    ) => Promise<Response>;
}

export function registerIceRoutes(app: Hono, input: RegisterIceRoutesInput): void {
    const rateLimit = new RateLimiterPolicy(
        input.configuration.rateLimit.windowMs,
        input.configuration.rateLimit.requests
    );
    const cache = new LoanedValue<IceConfig>(
        () =>
            readFreshIceConfig(
                input.configuration,
                input.nowEpochMs,
                input.readMeteredIceCandidates ?? getMeteredIceCandidates
            ),
        {
            ttlMs: input.configuration.cacheTtlMs,
            isValid: (value) => value.expiresAtEpochMs > input.nowEpochMs()
        }
    );
    app.get(
        '/api/webrtc/ice',
        async (c) => {
            try {
                const authSession = await input.requireApiAuthSession(c.req);

                return await RateLimiter.tryToExecuteOrDefault<Response>(
                    readRateLimiter('webrtc-ice', authSession.clientId, rateLimit),
                    async () => await readIceConfig(cache),
                    c.json({ error: 'Too many ICE configuration requests' }, 429)
                );
            }
            catch (e) {
                return toIceRouteErrorResponse(c, e);
            }
        }
    );
}

async function readIceConfig(cache: LoanedValue<IceConfig>): Promise<Response> {
    try {
        return toJsonResponse<IceConfig>(await cache.get());
    }
    catch (error) {
        if (error instanceof MeteredIceFetchError) {
            return toJsonResponse({ error: error.message }, 502);
        }

        throw error;
    }
}

async function readFreshIceConfig(
    configuration: ApiV1IceConfiguration,
    nowEpochMs: () => number,
    readMeteredIceCandidates: (configuration: ApiV1MeteredIceConfiguration) => Promise<Response>
): Promise<IceConfig> {
    if (configuration.mode === 'local') {
        return createLocalIceConfig(configuration.cacheTtlMs, nowEpochMs());
    }

    let res: Response;
    try {
        res = await readMeteredIceCandidates(configuration);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new MeteredIceFetchError(0, message);
    }

    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new MeteredIceFetchError(res.status, txt);
    }

    const iceServers = (await res.json()) as readonly RTCIceServer[];
    const expiresAtEpochMs = nowEpochMs() + configuration.cacheTtlMs;

    return { iceServers, expiresAtEpochMs };
}

export function createLocalIceConfig(
    cacheTtlMs: number,
    nowEpochMs = Date.now()
): IceConfig {
    return {
        iceServers: [],
        expiresAtEpochMs: nowEpochMs + cacheTtlMs
    };
}

function toIceRouteErrorResponse(
    c: {
        json(value: unknown, status?: number): Response;
    },
    error: unknown
): Response {
    if (error instanceof Error && error.message.startsWith('Unauthorized:')) {
        return toAuthErrorResponse(c, error);
    }

    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 500);
}
