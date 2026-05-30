import type { Context, Next } from 'jsr:@hono/hono';
import {
  nowMs,
  recordRallarTiming,
  type RallarTimingSink,
} from '@shared-server/rallar-system/services/timing.ts';
import { getApiTimingSink } from './timing-service.ts';

export type HttpTimingMiddlewareOptions = Readonly<{
  timing?: RallarTimingSink;
}>;

export function createHttpTimingMiddleware(
  options: HttpTimingMiddlewareOptions = {},
): (c: Context, next: Next) => Promise<void> {
  const timing = options.timing ?? getApiTimingSink();

  return async (c, next) => {
    const startedAt = nowMs();
    const requestId = c.req.header('x-request-id') ?? crypto.randomUUID();
    let thrown: unknown;

    c.header('x-request-id', requestId);

    try {
      await next();
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      const durationMs = nowMs() - startedAt;
      c.header('server-timing', `total;dur=${Math.round(durationMs * 100) / 100}`);
      recordRallarTiming(
        timing,
        {
          component: 'http',
          operation: 'request',
          requestId,
          method: c.req.method,
          path: c.req.path,
          httpStatus: thrown === undefined ? c.res.status : 500,
          details: {
            clientId: c.req.header('x-client-id'),
            origin: c.req.header('origin'),
            userAgent: c.req.header('user-agent'),
          },
        },
        thrown === undefined ? 'ok' : 'error',
        durationMs,
        thrown,
      );
    }
  };
}
