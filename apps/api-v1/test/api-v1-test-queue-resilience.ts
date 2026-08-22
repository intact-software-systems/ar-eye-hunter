import type { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';

import { toResilienceDto as toConfiguredResilienceDto } from '../src/middleware-resilience.ts';

export function toResilienceDto(): ResilienceDto {
    return toConfiguredResilienceDto({
        failureThreshold: 10,
        openDurationMs: 10_000,
        resetDurationMs: 10_000,
        samplingDurationMs: 10_000,
        initialRate: 1,
        maxRate: 10,
        increaseRate: 1,
        decreaseRate: 1,
        maxFairnessSelectionsPerWindow: 10
    });
}
