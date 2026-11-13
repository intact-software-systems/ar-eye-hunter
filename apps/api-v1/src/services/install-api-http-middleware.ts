import type { Hono } from 'hono';
import { cors } from 'hono/cors';

import type { RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import { AL_TRACE_ID_HTTP_HEADER } from '@shared/al-contracts/trace/al-trace-id.ts';

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
        allowHeaders: ['Content-Type', 'Authorization', 'x-client-id', 'If-None-Match', AL_TRACE_ID_HTTP_HEADER],
        exposeHeaders: [
            'Content-Length',
            'Server-Timing',
            AL_TRACE_ID_HTTP_HEADER,
            'Retry-After',
            'ETag',
            ...STATE_SNAPSHOT_READ_EXPOSED_HEADERS
        ],
        maxAge: input.http.preflightMaxAgeSeconds,
        credentials: true
    });

    app.use('/api/*', createHttpTimingMiddleware({ timing: input.timing }));
    app.use('/api/*', apiCors);
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
