import { Temporal } from '@js-temporal/polyfill';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/Resilience.ts';

const duration = Temporal.Duration.from({ seconds: 10 });
const MAX_FAIRNESS_SELECTIONS_PER_WINDOW = 10;

export function toResilienceDto() {
  return ResilienceDto.toResilienceDto(
    new CircuitBreakerPolicy(
      10,
      duration,
      duration,
      duration,
    ),
    1,
    10,
    1,
    1,
    MAX_FAIRNESS_SELECTIONS_PER_WINDOW,
  );
}
