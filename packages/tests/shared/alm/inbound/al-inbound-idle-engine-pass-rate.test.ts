import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';

import { createObservedVolatileInboundPair } from '../../multicast/rtc-relay-overlay-fixture.ts';
import {
    createInboundTestBackendStores,
    createInboundTestMessage,
    createInboundTestRuntime,
    INBOUND_TEST_SOURCE,
    type InboundTestRuntime
} from '../inbound-runtime-test-fixture.ts';

/** The engine's own fixed pass delay: an idle engine never needs more passes than one per this. */
const ENGINE_PASS_DELAY_MS = 100;
const IDLE_WINDOW_MS = 2_000;
const MAX_IDLE_PASSES = IDLE_WINDOW_MS / ENGINE_PASS_DELAY_MS;
/** The step the idle window advances in, so a spinning engine fails after a few steps instead of running out the window. */
const STEP_MS = 10;

describe('an idle inbound work engine', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-11-23T00:00:00Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('runs at most one pass per engine delay after one commit on one of its two rotation lanes', async () => {
        const fixture = await createStartedTwoLaneRuntime();
        const message = createInboundTestMessage({ msgId: 'idle-after-one-commit' });

        expect((await fixture.runtime.admitIncomingMessage(message, INBOUND_TEST_SOURCE)).right)
            .toEqual({ kind: 'admitted' });
        await vi.advanceTimersByTimeAsync(ENGINE_PASS_DELAY_MS);
        expect(fixture.delivered).toEqual(['dispatched']);

        const idle = await countPassesWithin(fixture, IDLE_WINDOW_MS);
        expect(idle.passes, `${idle.passes} passes in ${idle.elapsedMs} ms`).toBeLessThanOrEqual(MAX_IDLE_PASSES);
    });

    it('runs at most one pass per engine delay while both rotation lanes stay idle', async () => {
        const fixture = await createStartedTwoLaneRuntime();
        await vi.advanceTimersByTimeAsync(ENGINE_PASS_DELAY_MS);

        const idle = await countPassesWithin(fixture, IDLE_WINDOW_MS);
        expect(idle.passes, `${idle.passes} passes in ${idle.elapsedMs} ms`).toBeLessThanOrEqual(MAX_IDLE_PASSES);
    });
});

/** A runtime whose durable and volatile rotation lanes share one running engine, as a browser tab's do. */
async function createStartedTwoLaneRuntime(): Promise<InboundTestRuntime> {
    const fixture = createInboundTestRuntime({
        carrier: 'ws',
        stores: createInboundTestBackendStores({
            namespace: 'idle-durable',
            storage: 'memory',
            observer: createPassThroughIndexedDbOperationObserver()
        }).stores,
        volatileStores: createObservedVolatileInboundPair('idle-volatile').stores,
        effectWorkerId: 'al-inbound:idle'
    });
    await fixture.runtime.ready();
    fixture.queueEngine.start();
    return fixture;
}

/** Engine passes in `windowMs` of fake time; stops early once the bound is exceeded, so a spin fails fast. */
async function countPassesWithin(
    fixture: InboundTestRuntime,
    windowMs: number
): Promise<Readonly<{ passes: number; elapsedMs: number; }>> {
    const passes = vi.spyOn(fixture.queueEngine, 'executeOnce');
    try {
        let elapsedMs = 0;
        while (elapsedMs < windowMs && passes.mock.calls.length <= MAX_IDLE_PASSES) {
            await vi.advanceTimersByTimeAsync(STEP_MS);
            elapsedMs += STEP_MS;
        }
        return { passes: passes.mock.calls.length, elapsedMs };
    }
    finally {
        passes.mockRestore();
        await fixture.queueEngine.stop();
    }
}
