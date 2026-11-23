import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import {
    INBOX_OUTBOX_ENGINE_MAX_IDLE_MS,
    INBOX_OUTBOX_ENGINE_SCHEDULE_JITTER_RATIO
} from '@shared/services/inbox-outbox-engine.ts';

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
/** The longest an idle engine waits between two passes: its idle ceiling, stretched by the most jitter it applies. */
const IDLE_CEILING_WITH_JITTER_MS = INBOX_OUTBOX_ENGINE_MAX_IDLE_MS * (1 + INBOX_OUTBOX_ENGINE_SCHEDULE_JITTER_RATIO);
/** Long enough for the engine's idle backoff to reach its ceiling. */
const BACKED_OFF_MS = 10_000;

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

describe('a row an idle inbound work engine holds back', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-11-23T00:00:00Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('is delivered by the pass a consumer registration wakes, once dispatch is allowed', async () => {
        let dispatchable = false;
        const fixture = await createStartedTwoLaneRuntime(() => dispatchable);
        await admitHeldMessage(fixture, 'held-until-registration');
        await vi.advanceTimersByTimeAsync(BACKED_OFF_MS);
        expect(fixture.delivered).toEqual([]);

        // What `onInboxMessageDo` does for the consumer it registers: no fake time passes after it.
        dispatchable = true;
        fixture.queueEngine.wake();
        await vi.advanceTimersByTimeAsync(0);

        expect(fixture.delivered).toEqual(['dispatched']);
        await fixture.queueEngine.stop();
    });

    it('is delivered with no wake within the idle ceiling, while the engine keeps its pass bound', async () => {
        let dispatchable = false;
        const fixture = await createStartedTwoLaneRuntime(() => dispatchable);
        await admitHeldMessage(fixture, 'held-without-a-wake');

        const held = await countPassesUntil(fixture, BACKED_OFF_MS, () => false);
        expect(held.passes, `${held.passes} passes in ${held.elapsedMs} ms`)
            .toBeLessThanOrEqual(BACKED_OFF_MS / ENGINE_PASS_DELAY_MS);
        expect(fixture.delivered).toEqual([]);

        // An eligibility input that changes without announcing itself, as congestion relief does.
        dispatchable = true;
        const released = await countPassesUntil(fixture, IDLE_CEILING_WITH_JITTER_MS, () => fixture.delivered.length > 0);

        expect(fixture.delivered, `delivered after ${released.elapsedMs} ms`).toEqual(['dispatched']);
        expect(released.passes).toBeLessThanOrEqual(IDLE_CEILING_WITH_JITTER_MS / ENGINE_PASS_DELAY_MS);
        await fixture.queueEngine.stop();
    });
});

/** Admits one message whose delivery the runtime's dispatch rule holds back for now. */
async function admitHeldMessage(fixture: InboundTestRuntime, msgId: string): Promise<void> {
    expect((await fixture.runtime.admitIncomingMessage(createInboundTestMessage({ msgId }), INBOUND_TEST_SOURCE)).right)
        .toEqual({ kind: 'admitted' });
    await vi.advanceTimersByTimeAsync(ENGINE_PASS_DELAY_MS);
    expect(fixture.delivered).toEqual([]);
}

/** A runtime whose durable and volatile rotation lanes share one running engine, as a browser tab's do. */
async function createStartedTwoLaneRuntime(
    canDispatchMessage: (() => boolean) | undefined = undefined
): Promise<InboundTestRuntime> {
    const fixture = createInboundTestRuntime({
        canDispatchMessage,
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
    try {
        return await countPassesUntil(fixture, windowMs, () => false);
    }
    finally {
        await fixture.queueEngine.stop();
    }
}

/**
 * Engine passes until `settled` holds or `windowMs` of fake time ran out. Stops early once the passes
 * exceed one per engine delay of the window, so a spin fails fast.
 */
async function countPassesUntil(
    fixture: InboundTestRuntime,
    windowMs: number,
    settled: () => boolean
): Promise<Readonly<{ passes: number; elapsedMs: number; }>> {
    const passes = vi.spyOn(fixture.queueEngine, 'executeOnce');
    try {
        let elapsedMs = 0;
        while (elapsedMs < windowMs && !settled() && passes.mock.calls.length <= windowMs / ENGINE_PASS_DELAY_MS) {
            await vi.advanceTimersByTimeAsync(STEP_MS);
            elapsedMs += STEP_MS;
        }
        return { passes: passes.mock.calls.length, elapsedMs };
    }
    finally {
        passes.mockRestore();
    }
}
