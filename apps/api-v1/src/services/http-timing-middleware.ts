import type { Context, Next } from 'jsr:@hono/hono@4.11.9';

import { nowMs, recordRallarTiming, type RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import { decodeALTraceId, newALTraceId } from '@shared/al-contracts/trace/al-trace-id.ts';
import { toError } from '@shared/resilience/to-error.ts';

export interface HttpTimingMiddlewareOptions {
    readonly timing: RallarTimingSink;
}

/** Snapshotted before `next` runs: a handler may close the request before the timing is recorded. */
interface HttpTimingRequest {
    readonly traceId: string;
    readonly method: string;
    readonly path: string;
    readonly isWebSocketUpgrade: boolean;
    readonly details: Readonly<{
        clientId: string | undefined;
        origin: string | undefined;
        userAgent: string | undefined;
    }>;
}

interface HttpTimingOutcome {
    readonly request: HttpTimingRequest;
    readonly durationMs: number;
    readonly thrown: Error | undefined;
}

export function createHttpTimingMiddleware(
    options: HttpTimingMiddlewareOptions
): (c: Context, next: Next) => Promise<void> {
    return async (c, next) => {
        const startedAt = nowMs();
        const request = readHttpTimingRequest(c);
        let thrown: Error | undefined;

        c.set('traceId', request.traceId);
        try {
            await next();
        }
        catch (error) {
            thrown = toError(error);
            throw error;
        }
        finally {
            writeHttpRequestTiming(c, options.timing, { request, durationMs: nowMs() - startedAt, thrown });
        }
    };
}

function readHttpTimingRequest(c: Context): HttpTimingRequest {
    return {
        traceId: decodeALTraceId(c.req.header('x-request-id')).right ?? newALTraceId(),
        method: c.req.method,
        path: c.req.path,
        isWebSocketUpgrade: c.req.header('upgrade')?.trim().toLowerCase() === 'websocket',
        details: {
            clientId: c.req.header('x-client-id'),
            origin: c.req.header('origin'),
            userAgent: c.req.header('user-agent')
        }
    };
}

function writeHttpRequestTiming(c: Context, timing: RallarTimingSink, outcome: HttpTimingOutcome): void {
    const { request, durationMs, thrown } = outcome;
    const httpStatus = thrown === undefined ? c.res.status : 500;
    const failed = thrown !== undefined || httpStatus >= 400;
    if (httpStatus !== 101) {
        c.header('server-timing', `total;dur=${Math.round(durationMs * 100) / 100}`);
    }
    if (!request.isWebSocketUpgrade) {
        c.header('x-request-id', request.traceId);
    }
    recordRallarTiming({
        sink: timing,
        event: {
            component: 'http',
            operation: 'request',
            // An HTTP request has no request id but its trace, so both name the same value.
            requestId: request.traceId,
            traceId: request.traceId,
            method: request.method,
            path: request.path,
            httpStatus,
            details: request.details
        },
        status: failed ? 'error' : 'ok',
        durationMs,
        error: thrown ?? (failed ? new Error(`HTTP ${httpStatus}`) : undefined)
    });
}
