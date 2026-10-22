import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import assert from 'node:assert/strict';

import { createManualTimers, type ManualTimers } from '../../../../packages/tests/shared/resilience/manual-timers.ts';
import { decodeApiV1Configuration } from '../../src/configuration/decode-api-v1-configuration.ts';
import {
    resolveExposedGarbageCollector,
    startHeapSampleTiming,
    type StartHeapSampleTimingInput
} from '../../src/services/start-heap-sample-timing.ts';
import { toTimingOnSink } from '../../src/services/timing-service.ts';
import { validDecodeApiV1ConfigurationInput } from '../configuration/api-v1-configuration-test-fixture.ts';

const INTERVAL_MS = 30_000;
const MEMORY: Deno.MemoryUsage = { rss: 90_000_000, heapUsed: 40_000_000, heapTotal: 60_000_000, external: 2_000_000 };

interface SamplerReads {
    readonly calls: string[];
    readonly input: StartHeapSampleTimingInput;
}

Deno.test('timing on records one api-process heap-sample line per interval, read after a forced full collection', async () => {
    const timers = createManualTimers(0);
    const events: RallarTimingEvent[] = [];
    const reads = createSamplerReads(timers, (event) => events.push(event), () => undefined);
    const stop = startHeapSampleTiming(reads.input);

    await timers.advanceTo(INTERVAL_MS - 1);
    assert.equal(events.length, 0);
    await timers.advanceTo(2 * INTERVAL_MS);

    assert.deepEqual(reads.calls, ['gc', 'memory', 'uptime', 'gc', 'memory', 'uptime']);
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
        [1_234, 1_234].map((uptimeMs) => ({
            type: 'rallar.timing',
            component: 'api-process',
            operation: 'heap-sample',
            status: 'ok',
            durationMs: INTERVAL_MS,
            serviceId: 'api-1',
            details: { ...MEMORY, forcedGc: true, uptimeMs }
        }))
    );
    stop();
    assert.equal(timers.pendingCount(), 0);
});

Deno.test('a sample without an exposed collector reads the heap as it stands and says forcedGc false', async () => {
    const timers = createManualTimers(0);
    const events: RallarTimingEvent[] = [];
    const reads = createSamplerReads(timers, (event) => events.push(event), undefined);
    const stop = startHeapSampleTiming(reads.input);

    await timers.advanceTo(INTERVAL_MS);

    assert.deepEqual(reads.calls, ['memory', 'uptime']);
    assert.equal(events[0]?.details?.forcedGc, false);
    stop();
});

Deno.test('timing off schedules nothing, so no sample is built, collected, read or timed', async () => {
    const configuration = decodeApiV1Configuration(validDecodeApiV1ConfigurationInput());
    const failing = (): void => {
        throw new Error('a timing-off heap sample must not reach a sink');
    };
    const timers = createManualTimers(0);
    const reads = createSamplerReads(
        timers,
        toTimingOnSink({ ...configuration.observability, timingLogs: false }, failing),
        () => undefined
    );

    const stop = startHeapSampleTiming(reads.input);
    await timers.advanceTo(10 * INTERVAL_MS);

    assert.equal(timers.pendingCount(), 0);
    assert.deepEqual(reads.calls, []);
    stop();
});

Deno.test('the collector is the global gc only where the runtime exposes it as a function', () => {
    const collected: string[] = [];
    const collector = resolveExposedGarbageCollector({ gc: () => collected.push('gc') });
    collector?.();

    assert.deepEqual(collected, ['gc']);
    assert.equal(resolveExposedGarbageCollector({}), undefined);
    assert.equal(resolveExposedGarbageCollector({ gc: 'not a function' }), undefined);
});

/** Records every collection, memory read, uptime read and clock read the sampler makes, in order. */
function createSamplerReads(
    timers: ManualTimers,
    timing: StartHeapSampleTimingInput['timing'],
    collectGarbage: (() => void) | undefined
): SamplerReads {
    const calls: string[] = [];
    return {
        calls,
        input: {
            timers: {
                nowMs: () => {
                    calls.push('clock');
                    return timers.nowMs();
                },
                schedule: (run, delayMs) => timers.schedule(run, delayMs)
            },
            timing,
            serviceId: 'api-1',
            intervalMs: INTERVAL_MS,
            collectGarbage: collectGarbage === undefined ? undefined : () => {
                calls.push('gc');
                collectGarbage();
            },
            readMemoryUsage: () => {
                calls.push('memory');
                return MEMORY;
            },
            readUptimeMs: () => {
                calls.push('uptime');
                return 1_234.4;
            }
        }
    };
}
