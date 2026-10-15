import type { RallarMiddlewareResilience } from '@shared-server/rallar-system/middleware/rallar-middleware-construction.ts';
import type { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';

import { createApiV1MiddlewareResilience } from '../src/middleware-resilience.ts';

export function createApiV1TestMiddlewareResilience(): RallarMiddlewareResilience {
    return createApiV1MiddlewareResilience({
        failureThreshold: 10,
        openDurationMs: 10_000,
        resetDurationMs: 10_000,
        samplingDurationMs: 10_000,
        initialRate: 1,
        maxRate: 10,
        increaseRate: 1,
        decreaseRate: 1
    });
}

export function createApiV1TestQueueResilience(): ResourceInboxResilience {
    return createApiV1TestMiddlewareResilience().inbox;
}
