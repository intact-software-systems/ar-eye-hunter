import { Temporal } from '@js-temporal/polyfill';
import { readRateLimiter, readRequestClientKey } from '@shared-server/http/rate-limit-service.ts';
import { CircuitBreaker, CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { RateLimiter, RateLimiterPolicy } from '@shared/resilience/Resilience.ts';
import type { Context, Next } from 'jsr:@hono/hono@4.11.9';
import type { ApiV1StateApiConfiguration } from '../configuration/api-v1-configuration.ts';
import {
    toApiMutationRateLimitResponse,
    toApiMutationUnavailableResponse
} from '../routes/api-mutation-route-failure.ts';
import { isClientStateMutationRoute } from '../routes/is-client-state-mutation-route.ts';

export type StateApiResilienceMiddlewareOptions = Readonly<{
    configuration: ApiV1StateApiConfiguration;
    namespace?: string;
}>;

export function createStateApiResilienceMiddleware(
    options: StateApiResilienceMiddlewareOptions
): (c: Context, next: Next) => Promise<Response> {
    const namespace = options.namespace ?? 'state-api';
    const stateRateLimitPolicy = new RateLimiterPolicy(
        options.configuration.rateLimits.windowMs,
        options.configuration.rateLimits.request
    );
    const eventListRateLimitPolicy = new RateLimiterPolicy(
        options.configuration.rateLimits.windowMs,
        options.configuration.rateLimits.eventList
    );
    const circuitBreaker = createStateApiCircuitBreaker(options.configuration);

    return async (c, next) => {
        const isClientMutation = isClientStateMutationRoute(c.req.method, c.req.path);
        const limiter = readRateLimiter(
            toRateLimiterNamespace(namespace, c.req.path),
            readAuthenticatedClientKey(c),
            isEventListRequest(c.req.path) ? eventListRateLimitPolicy : stateRateLimitPolicy
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
                    (response) => response.status < 500
                );

                return result.fold(
                    () =>
                        isClientMutation
                            ? toApiMutationUnavailableResponse(
                                c,
                                'State API is temporarily unavailable'
                            )
                            : c.json({ error: 'State API is temporarily unavailable' }, 503),
                    (response) => response
                );
            },
            isClientMutation
                ? toApiMutationRateLimitResponse(
                    c,
                    'Too many state API requests',
                    stateRateLimitPolicy.timebasedFilterMs
                )
                : c.json({ error: 'Too many state API requests' }, 429)
        );
    };
}

function createStateApiCircuitBreaker(
    configuration: ApiV1StateApiConfiguration
): CircuitBreaker {
    return CircuitBreaker.create(
        new CircuitBreakerPolicy(
            configuration.circuitBreaker.failureThreshold,
            Temporal.Duration.from({ milliseconds: configuration.circuitBreaker.openDurationMs }),
            Temporal.Duration.from({ milliseconds: configuration.circuitBreaker.resetDurationMs }),
            Temporal.Duration.from({ milliseconds: configuration.circuitBreaker.samplingDurationMs })
        )
    );
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
