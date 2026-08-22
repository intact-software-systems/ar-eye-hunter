import { Temporal } from '@js-temporal/polyfill';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import type { ApiV1QueueResilienceConfiguration } from './configuration/api-v1-configuration.ts';

export function toResilienceDto(configuration: ApiV1QueueResilienceConfiguration) {
    return ResilienceDto.toResilienceDto(
        new CircuitBreakerPolicy(
            configuration.failureThreshold,
            Temporal.Duration.from({ milliseconds: configuration.openDurationMs }),
            Temporal.Duration.from({ milliseconds: configuration.resetDurationMs }),
            Temporal.Duration.from({ milliseconds: configuration.samplingDurationMs })
        ),
        configuration.initialRate,
        configuration.maxRate,
        configuration.increaseRate,
        configuration.decreaseRate,
        configuration.maxFairnessSelectionsPerWindow
    );
}
