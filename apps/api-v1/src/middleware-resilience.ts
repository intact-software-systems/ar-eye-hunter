import { Temporal } from '@js-temporal/polyfill';
import { APP_INBOX_RESERVATION_LEASE_MS } from '@shared-server/rallar-system/app-inbox/app-inbox-options.ts';
import type { RallarMiddlewareResilience } from '@shared-server/rallar-system/middleware/rallar-middleware-construction.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import type { ApiV1CircuitBreakerConfiguration } from './configuration/api-v1-configuration.ts';

/** AppInbox claims are reclaimed after the AppInbox lease; both outboxes keep the default five-minute lease. */
export function createApiV1MiddlewareResilience(
    configuration: ApiV1CircuitBreakerConfiguration
): RallarMiddlewareResilience {
    return {
        inbox: createApiV1QueueResilience(configuration, APP_INBOX_RESERVATION_LEASE_MS),
        outbox: createApiV1QueueResilience(configuration, ResourceInboxResilience.DEFAULT_RESERVATION_LEASE_MS),
        appOutbox: createApiV1QueueResilience(configuration, ResourceInboxResilience.DEFAULT_RESERVATION_LEASE_MS)
    };
}

export function createApiV1QueueResilience(
    configuration: ApiV1CircuitBreakerConfiguration,
    reservationLeaseMs: number
): ResourceInboxResilience {
    return ResourceInboxResilience.createDefault({
        circuitBreakerPolicy: new CircuitBreakerPolicy(
            configuration.failureThreshold,
            Temporal.Duration.from({ milliseconds: configuration.openDurationMs }),
            Temporal.Duration.from({ milliseconds: configuration.resetDurationMs }),
            Temporal.Duration.from({ milliseconds: configuration.samplingDurationMs })
        ),
        reservationLeaseMs
    });
}
