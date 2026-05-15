import { Temporal } from '@js-temporal/polyfill';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/Resilience.ts';

const duration = Temporal.Duration.from({ seconds: 10 });
const initialRate = 1;
const maxRate = 10;
const concurrencyIncreaseStep = 1;
const concurrencyReduceStep = 1;

const circuitBreakerPolicy = new CircuitBreakerPolicy(
    10,
    duration,
    duration,
    duration,
);

export function toResilienceDto() {
    return ResilienceDto.toResilienceDto(
        circuitBreakerPolicy,
        initialRate,
        maxRate,
        concurrencyIncreaseStep,
        concurrencyReduceStep,
    );
}
