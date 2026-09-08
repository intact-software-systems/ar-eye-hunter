import { Temporal } from '@js-temporal/polyfill';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import type { ApiV1QueueResilienceConfiguration } from './configuration/api-v1-configuration.ts';

export function createApiV1QueueResilience(configuration: ApiV1QueueResilienceConfiguration) {
    return ResourceInboxResilience.createDefault({
        circuitBreakerPolicy: new CircuitBreakerPolicy(
            configuration.failureThreshold,
            Temporal.Duration.from({ milliseconds: configuration.openDurationMs }),
            Temporal.Duration.from({ milliseconds: configuration.resetDurationMs }),
            Temporal.Duration.from({ milliseconds: configuration.samplingDurationMs })
        ),
        initialRate: configuration.initialRate,
        maxRate: configuration.maxRate,
        concurrencyIncreaseStep: configuration.increaseRate,
        concurrencyReduceStep: configuration.decreaseRate,
        maxFairnessSelectionsInWindow: configuration.maxFairnessSelectionsPerWindow
    });
}
