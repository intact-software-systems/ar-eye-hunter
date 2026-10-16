import type { RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import type { Hono } from 'jsr:@hono/hono@4.11.9';
import { cors } from 'jsr:@hono/hono@4.11.9/cors';

import type {
    ApiV1HttpConfiguration,
    ApiV1StateApiConfiguration
} from '../configuration/api-v1-configuration.ts';
import {
    STATE_SNAPSHOT_READ_EXPOSED_HEADERS
} from '../routes/state-snapshot-read/state-snapshot-read-exposed-headers.ts';
import { createHttpTimingMiddleware } from './http-timing-middleware.ts';
import { createStateApiResilienceMiddleware } from './state-api-resilience-middleware.ts';

export interface InstallApiHttpMiddlewareInput {
    readonly http: ApiV1HttpConfiguration;
    readonly stateApi: ApiV1StateApiConfiguration;
    readonly timing: RallarTimingSink;
}

/** Timing runs outermost, so a preflight the CORS middleware answers by itself is timed as well. */
export function installApiHttpMiddleware(app: Hono, input: InstallApiHttpMiddlewareInput): void {
    const apiCors = cors({
        origin: (origin) => resolveCorsOrigin(origin, input.http.corsOrigins),
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization', 'x-client-id'],
        exposeHeaders: [
            'Content-Length',
            'Server-Timing',
            'x-request-id',
            'Retry-After',
            ...STATE_SNAPSHOT_READ_EXPOSED_HEADERS
        ],
        maxAge: input.http.preflightMaxAgeSeconds,
        credentials: true
    });

    app.use('/api/*', createHttpTimingMiddleware({ timing: input.timing }));
    app.use('/api/*', async (c, next) => {
        if (isWebSocketUpgradeRequest(c.req.path, c.req.header('upgrade'))) {
            await next();
            return;
        }

        return await apiCors(c, next);
    });
    app.use('/api/state/*', createStateApiResilienceMiddleware({ configuration: input.stateApi }));
}

function resolveCorsOrigin(
    origin: string,
    allowedOrigins: readonly string[]
): string | undefined {
    if (allowedOrigins.includes('*')) {
        return origin || undefined;
    }

    return allowedOrigins.includes(origin) ? origin : undefined;
}

function isWebSocketUpgradeRequest(path: string, upgrade?: string): boolean {
    return path.startsWith('/api/ws/') && upgrade?.trim().toLowerCase() === 'websocket';
}
