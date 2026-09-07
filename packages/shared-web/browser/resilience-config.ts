import { Temporal } from '@js-temporal/polyfill';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';

const duration = Temporal.Duration.from({ seconds: 10 });

export function createBrowserQueueResilience() {
    return ResourceInboxResilience.createDefault({
        circuitBreakerPolicy: new CircuitBreakerPolicy(
            10,
            duration,
            duration,
            duration
        ),
        initialRate: 1,
        maxRate: 10,
        concurrencyIncreaseStep: 1,
        concurrencyReduceStep: 1
    });
}
