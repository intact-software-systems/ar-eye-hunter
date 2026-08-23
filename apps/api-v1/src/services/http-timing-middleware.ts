import { nowMs, recordRallarTiming, type RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import type { Context, Next } from 'jsr:@hono/hono@4.11.9';

export type HttpTimingMiddlewareOptions = Readonly<{
    timing: RallarTimingSink;
}>;

export function createHttpTimingMiddleware(
    options: HttpTimingMiddlewareOptions
): (c: Context, next: Next) => Promise<void> {
    const timing = options.timing;

    return async (c, next) => {
        const startedAt = nowMs();
        const method = c.req.method;
        const path = c.req.path;
        const upgrade = c.req.header('upgrade');
        const requestId = c.req.header('x-request-id') ?? crypto.randomUUID();
        const details = {
            clientId: c.req.header('x-client-id'),
            origin: c.req.header('origin'),
            userAgent: c.req.header('user-agent')
        };
        const isWebSocketUpgrade = upgrade?.trim().toLowerCase() === 'websocket';
        let thrown: unknown;

        if (!isWebSocketUpgrade) {
            c.header('x-request-id', requestId);
        }

        try {
            await next();
        }
        catch (error) {
            thrown = error;
            throw error;
        }
        finally {
            const durationMs = nowMs() - startedAt;
            const httpStatus = thrown === undefined ? c.res.status : 500;
            const failed = thrown !== undefined || httpStatus >= 400;
            if (httpStatus !== 101) {
                c.header('server-timing', `total;dur=${Math.round(durationMs * 100) / 100}`);
            }
            recordRallarTiming({
                sink: timing,
                event: {
                    component: 'http',
                    operation: 'request',
                    requestId,
                    method,
                    path,
                    httpStatus,
                    details
                },
                status: failed ? 'error' : 'ok',
                durationMs,
                error: thrown ?? (failed ? new Error(`HTTP ${httpStatus}`) : undefined)
            });
        }
    };
}
