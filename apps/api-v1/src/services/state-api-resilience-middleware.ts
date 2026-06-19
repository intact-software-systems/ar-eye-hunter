import type { Context, Next } from 'jsr:@hono/hono@4.11.9';
import { Temporal } from '@js-temporal/polyfill';
import {
  CircuitBreaker,
  CircuitBreakerPolicy,
  RateLimiter,
  RateLimiterPolicy,
} from '@shared/resilience/Resilience.ts';
import { readRateLimiter, readRequestClientKey } from '@shared-server/http/rate-limit-service.ts';

const STATE_API_RATE_LIMIT = new RateLimiterPolicy(60_000, 300);
const STATE_EVENT_LIST_RATE_LIMIT = new RateLimiterPolicy(60_000, 60);
const STATE_API_CIRCUIT_DURATION = Temporal.Duration.from({ seconds: 10 });
const STATE_API_CIRCUIT_BREAKER = CircuitBreaker.create(
  new CircuitBreakerPolicy(
    10,
    STATE_API_CIRCUIT_DURATION,
    STATE_API_CIRCUIT_DURATION,
    STATE_API_CIRCUIT_DURATION,
  ),
);

export type StateApiResilienceMiddlewareOptions = Readonly<{
  namespace?: string;
  stateRateLimitPolicy?: RateLimiterPolicy;
  eventListRateLimitPolicy?: RateLimiterPolicy;
  circuitBreaker?: CircuitBreaker;
}>;

export function createStateApiResilienceMiddleware(
  options: StateApiResilienceMiddlewareOptions = {},
): (c: Context, next: Next) => Promise<Response> {
  const namespace = options.namespace ?? 'state-api';
  const stateRateLimitPolicy = options.stateRateLimitPolicy ??
    STATE_API_RATE_LIMIT;
  const eventListRateLimitPolicy = options.eventListRateLimitPolicy ??
    STATE_EVENT_LIST_RATE_LIMIT;
  const circuitBreaker = options.circuitBreaker ??
    STATE_API_CIRCUIT_BREAKER;

  return async (c, next) => {
    const limiter = readRateLimiter(
      toRateLimiterNamespace(namespace, c.req.path),
      readAuthenticatedClientKey(c),
      isEventListRequest(c.req.path) ? eventListRateLimitPolicy : stateRateLimitPolicy,
    );

    return await RateLimiter.tryToExecuteOrDefault<Response>(
      limiter,
      async () => {
        const result = await CircuitBreaker.tryToExecute<Response>(
          circuitBreaker,
          async () => {
            await next();
            return c.res;
          },
          (response) => response.status < 500,
        );

        return result.fold(
          () =>
            c.json(
              { error: 'State API is temporarily unavailable' },
              503,
            ),
          (response) => response,
        );
      },
      c.json({ error: 'Too many state API requests' }, 429),
    );
  };
}

function toRateLimiterNamespace(namespace: string, path: string): string {
  return isEventListRequest(path) ? `${namespace}:events` : namespace;
}

function isEventListRequest(path: string): boolean {
  return path.endsWith('/events') || path.endsWith('/events/page');
}

function readAuthenticatedClientKey(c: Context): string {
  return c.req.header('x-client-id') ??
    readRequestClientKey(c.req);
}
