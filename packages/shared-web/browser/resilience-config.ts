import { Temporal } from '@js-temporal/polyfill';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';

const duration = Temporal.Duration.from({ seconds: 10 });

export function toResilienceDto() {
    return ResilienceDto.toResilienceDto(
        new CircuitBreakerPolicy(
            10,
            duration,
            duration,
            duration
        ),
        1,
        10,
        1,
        1
    );
}
