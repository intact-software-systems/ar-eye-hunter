import { Temporal } from '@js-temporal/polyfill';

import { APP_INBOX_RESERVATION_LEASE_MS } from '@shared-server/rallar-system/app-inbox/app-inbox-options.ts';
import type { RallarMiddlewareResilience } from '@shared-server/rallar-system/middleware/rallar-middleware-construction.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY, type ResourceInboxRetryPolicy } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';

import type { ApiV1AppInboxRetryConfiguration, ApiV1CircuitBreakerConfiguration } from './configuration/api-v1-configuration.ts';

/** AppInbox claims are reclaimed after the AppInbox lease; both outboxes keep the default five-minute lease. */
export function createApiV1MiddlewareResilience(
    configuration: ApiV1CircuitBreakerConfiguration,
    appInboxRetry: ApiV1AppInboxRetryConfiguration
): RallarMiddlewareResilience {
    return {
        inbox: createApiV1QueueResilience(configuration, APP_INBOX_RESERVATION_LEASE_MS, {
            ...DEFAULT_RESOURCE_INBOX_RETRY_POLICY,
            maxAttempts: appInboxRetry.maxAttempts,
            maxDelayMs: appInboxRetry.maxDelayMs
        }),
        outbox: createApiV1QueueResilience(configuration, ResourceInboxResilience.DEFAULT_RESERVATION_LEASE_MS, DEFAULT_RESOURCE_INBOX_RETRY_POLICY),
        appOutbox: createApiV1QueueResilience(configuration, ResourceInboxResilience.DEFAULT_RESERVATION_LEASE_MS, DEFAULT_RESOURCE_INBOX_RETRY_POLICY)
    };
}

export function createApiV1QueueResilience(
    configuration: ApiV1CircuitBreakerConfiguration,
    reservationLeaseMs: number,
    retryPolicy: ResourceInboxRetryPolicy
): ResourceInboxResilience {
    return ResourceInboxResilience.create({
        circuitBreakerPolicy: new CircuitBreakerPolicy(
            configuration.failureThreshold,
            Temporal.Duration.from({ milliseconds: configuration.openDurationMs }),
            Temporal.Duration.from({ milliseconds: configuration.resetDurationMs }),
            Temporal.Duration.from({ milliseconds: configuration.samplingDurationMs })
        ),
        retryPolicy,
        reservationLeaseMs
    });
}
