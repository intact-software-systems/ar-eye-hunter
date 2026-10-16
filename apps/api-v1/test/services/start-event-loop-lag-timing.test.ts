import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import assert from 'node:assert/strict';

import { createManualTimers } from '../../../../packages/tests/shared/resilience/manual-timers.ts';
import { startEventLoopLagTiming } from '../../src/services/start-event-loop-lag-timing.ts';

Deno.test('event-loop lag timing records one timing line per one-second window', async () => {
    const timers = createManualTimers(0);
    const events: RallarTimingEvent[] = [];
    const stop = startEventLoopLagTiming({
        timers,
        timing: (event) => events.push(event),
        serviceId: 'api-1'
    });

    await timers.advanceTo(999);
    assert.equal(events.length, 0);
    await timers.advanceTo(2_000);

    assert.deepEqual(
        events.map((event) => ({
            type: event.type,
            component: event.component,
            operation: event.operation,
            status: event.status,
            durationMs: event.durationMs,
            serviceId: event.serviceId,
            details: event.details
        })),
        [0, 1].map(() => ({
            type: 'rallar.timing',
            component: 'runtime',
            operation: 'event-loop-lag',
            status: 'ok',
            durationMs: 1_000,
            serviceId: 'api-1',
            details: { sampleCount: 20, maxLagMs: 0, p50LagMs: 0 }
        }))
    );
    stop();
    assert.equal(timers.pendingCount(), 0);
});
