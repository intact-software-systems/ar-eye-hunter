import {CircuitBreakerPolicy} from "@shared/resilience/Resilience.ts";
import {ResilienceDto} from "@shared/queuebox/DequeueResourceEntryController.ts";

const env = (import.meta as any).env;
export const apiBaseUrl = (env?.API_BASE_URL as string) || 'http://localhost:8080';

const duration = Temporal.Duration.from({seconds: 10});
const initialRate = 1;
const maxRate = 10;
const concurrencyIncreaseStep = 1;
const concurrencyReduceStep = 1;

const circuitBreakerPolicy =
    new CircuitBreakerPolicy(
        10,
        duration,
        duration,
        duration
    )

export function toResilienceDto() {
    return ResilienceDto.toResilienceDto(
        circuitBreakerPolicy,
        initialRate,
        maxRate,
        concurrencyIncreaseStep,
        concurrencyReduceStep
    )
}

