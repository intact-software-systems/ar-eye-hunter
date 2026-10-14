import { describe, expect, it } from 'vitest';

import { waitForBarrier } from '../../../shared-test/rallar-bb-test/barrier/wait-for-barrier.ts';
import { createDefaultRallarBlackBoxTestRuntime } from '../../../shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';

describe('black-box runtime event history', () => {
    it('bounds retained redacted payloads while counting every event by kind', () => {
        let now = 1_000;
        const runtime = createDefaultRallarBlackBoxTestRuntime({
            now: () => now++,
            eventHistory: { mode: 'recent', maxEvents: 3 }
        });
        const observed: string[] = [];
        runtime.subscribe((state) => {
            const event = state.events.at(-1);
            if (event) {
                observed.push(event.topic);
            }
        });
        for (let index = 0; index < 12; index++) {
            runtime.recordEvent({
                kind: index % 2 === 0 ? 'message' : 'diagnostic',
                topic: `history.${index}`,
                payload: { index, accessToken: 'secret' }
            });
        }

        expect(runtime.state().events.map((event) => event.topic)).toEqual(['history.9', 'history.10', 'history.11']);
        expect(runtime.state().events.map((event) => event.payload)).toEqual([
            { index: 9, accessToken: '<redacted>' },
            { index: 10, accessToken: '<redacted>' },
            { index: 11, accessToken: '<redacted>' }
        ]);
        expect(observed).toEqual(Array.from({ length: 12 }, (_, index) => `history.${index}`));
        expect(runtime.state().eventHistory).toMatchObject({
            policy: { mode: 'recent', maxEvents: 3 },
            generation: 0,
            totalEvents: 12,
            retainedEvents: 3,
            evictedEvents: 9,
            evictedThroughEpochMs: 1_008,
            countsByKind: { message: 6, diagnostic: 6, result: 0 },
            reconnects: 0
        });
    });

    it('keeps full history by default and exposes cumulative health and stats', async () => {
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        for (let index = 0; index < 10; index++) {
            runtime.recordEvent({ kind: 'message', topic: 'history.message' });
        }

        const health = await runtime.execute({ kind: 'health', commandId: 'health' });
        const stats = await runtime.execute({ kind: 'stats', commandId: 'stats' });

        expect(health.value).toMatchObject({ eventCount: 10, eventHistory: { policy: { mode: 'full' }, totalEvents: 10 } });
        expect(stats.value).toMatchObject({ counters: { events: 11, messages: 10 }, eventHistory: { evictedEvents: 0 } });
        expect(runtime.state().events).toHaveLength(13);
    });

    it('keeps counts through close and resets them for a new history generation', async () => {
        const runtime = createDefaultRallarBlackBoxTestRuntime({ eventHistory: { mode: 'recent', maxEvents: 2 } });
        for (let index = 0; index < 5; index++) {
            runtime.recordEvent({ kind: 'diagnostic', topic: 'history.reconnect' });
        }
        await runtime.execute({ kind: 'close', commandId: 'close' });
        expect(runtime.state().eventHistory).toMatchObject({ totalEvents: 7, reconnects: 5 });

        await runtime.execute({ kind: 'reset', commandId: 'reset' });

        expect(runtime.state().eventHistory).toMatchObject({
            policy: { mode: 'recent', maxEvents: 2 },
            generation: 1,
            totalEvents: 1,
            retainedEvents: 1,
            evictedEvents: 0,
            countsByKind: { diagnostic: 0, result: 1 },
            reconnects: 0
        });
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses an invalid event limit %s at construction', (maxEvents) => {
        expect(() => createDefaultRallarBlackBoxTestRuntime({ eventHistory: { mode: 'recent', maxEvents } })).toThrow(TypeError);
    });

    it('owns an immutable copy of the construction policy', () => {
        const policy = { mode: 'recent', maxEvents: 2 } as const;
        const runtime = createDefaultRallarBlackBoxTestRuntime({ eventHistory: policy });
        Object.assign(policy, { maxEvents: 20 });
        for (let index = 0; index < 5; index++) {
            runtime.recordEvent({ kind: 'event', topic: 'history.event' });
        }
        expect(runtime.state().events).toHaveLength(2);
        expect(runtime.state().eventHistory.policy).toEqual({ mode: 'recent', maxEvents: 2 });
        expect(Object.isFrozen(runtime.state().eventHistory.policy)).toBe(true);
    });

    it('preserves current connection facts after the connect diagnostic is evicted', async () => {
        const runtime = createDefaultRallarBlackBoxTestRuntime({ eventHistory: { mode: 'recent', maxEvents: 2 } });
        runtime.recordEvent({ kind: 'diagnostic', topic: 'rallar.browser.connect_completed', payload: { peerCount: 2 } });
        for (let index = 0; index < 5; index++) {
            runtime.recordEvent({ kind: 'event', topic: 'history.event' });
        }
        const connected = await runtime.execute({ kind: 'stats', commandId: 'connected' });
        expect(connected.value).toMatchObject({ counters: { events: 6, diagnostics: 1 }, rallar: { connected: true, peerCount: 2 } });

        await runtime.execute({ kind: 'close', commandId: 'close' });
        const closed = await runtime.execute({ kind: 'stats', commandId: 'closed' });
        expect(closed.value).toMatchObject({ rallar: { connected: false } });
    });

    it('refuses an uncovered historical wait and a full-history assertion', async () => {
        let now = 1_000;
        const runtime = createDefaultRallarBlackBoxTestRuntime({ now: () => now++, eventHistory: { mode: 'recent', maxEvents: 2 } });
        runtime.recordEvent({ kind: 'message', topic: 'old.forbidden' });
        for (let index = 0; index < 5; index++) {
            runtime.recordEvent({ kind: 'event', topic: 'new.event' });
        }

        const wait = await runtime.execute({ kind: 'wait', commandId: 'old-wait', timeoutMs: 0, absent: true, match: { topic: 'old.forbidden' } });
        const assertion = await runtime.execute({ kind: 'assert', commandId: 'old-assert', source: 'messages.length', operator: 'equals', expected: 0 });

        expect(wait.error?.code).toBe('RALLAR_BLACK_BOX_HISTORY_UNAVAILABLE');
        expect(assertion.error?.code).toBe('RALLAR_BLACK_BOX_HISTORY_UNAVAILABLE');
    });

    it.each([
        { source: 'messages.0.payload.recipients', comparisonSource: 'config.defaults.recipients' },
        { source: 'config.defaults.recipients', comparisonSource: 'messages.0.payload.recipients' },
        { source: 'recentMessages.0.payload.recipients', comparisonSource: 'config.defaults.recipients' },
        { source: 'config.defaults.recipients', comparisonSource: 'recentMessages.0.payload.recipients' }
    ])('refuses set equality over truncated history in $source or $comparisonSource', async ({ source, comparisonSource }) => {
        const runtime = createDefaultRallarBlackBoxTestRuntime({ eventHistory: { mode: 'recent', maxEvents: 2 } });
        await runtime.execute({ kind: 'configure', config: { defaults: { recipients: ['b'] } } });
        runtime.recordEvent({ kind: 'message', topic: 'earlier.audience', payload: { recipients: ['a', 'b'] } });
        runtime.recordEvent({ kind: 'message', topic: 'latest.audience', payload: { recipients: ['b'] } });
        runtime.recordEvent({ kind: 'event', topic: 'later.event' });

        const result = await runtime.execute({ kind: 'assert', source, operator: 'sameUniqueStringSet', comparisonSource });

        expect(result.error?.code).toBe('RALLAR_BLACK_BOX_HISTORY_UNAVAILABLE');
    });

    it.each([
        { source: 'recentMessages.0.payload.recipients', comparisonSource: 'config.defaults.recipients' },
        { source: 'config.defaults.recipients', comparisonSource: 'recentMessages.0.payload.recipients' }
    ])('compares covered recent message sets after other event kinds are evicted in $source or $comparisonSource', async ({ source, comparisonSource }) => {
        const runtime = createDefaultRallarBlackBoxTestRuntime({ eventHistory: { mode: 'recent', maxEvents: 2 } });
        await runtime.execute({ kind: 'configure', config: { defaults: { recipients: ['b', 'a'] } } });
        runtime.recordEvent({ kind: 'event', topic: 'earlier.event' });
        runtime.recordEvent({ kind: 'message', topic: 'current.audience', payload: { recipients: ['a', 'b'] } });
        runtime.recordEvent({ kind: 'event', topic: 'later.event' });

        const result = await runtime.execute({ kind: 'assert', source, operator: 'sameUniqueStringSet', comparisonSource });

        expect(result.ok).toBe(true);
        expect(result.value).toMatchObject({ exists: true, comparisonExists: true, passed: true });
    });

    it('matches a retained event using a covered inclusive time cursor', async () => {
        let now = 1_000;
        const runtime = createDefaultRallarBlackBoxTestRuntime({ now: () => now++, eventHistory: { mode: 'recent', maxEvents: 3 } });
        for (let index = 0; index < 5; index++) {
            runtime.recordEvent({ kind: 'message', topic: 'history.message' });
        }
        const result = await runtime.execute({
            kind: 'wait',
            commandId: 'retained-wait',
            timeoutMs: 0,
            match: { topic: 'history.message', sinceEpochMs: 1_004 }
        });
        expect(result.status).toBe('ok');
        expect(result.value).toMatchObject({ event: { atEpochMs: 1_004 } });
    });

    it('retains only the latest forbidden witness through the absence deadline even after eviction', async () => {
        let now = 1_000;
        const hold = Promise.withResolvers<void>();
        const started = Promise.withResolvers<void>();
        const runtime = createDefaultRallarBlackBoxTestRuntime({
            now: () => now,
            eventHistory: { mode: 'recent', maxEvents: 2 },
            sleep: async (ms) => {
                started.resolve();
                await hold.promise;
                now += ms;
            }
        });
        const pending = runtime.execute({
            kind: 'wait',
            commandId: 'absence',
            absent: true,
            timeoutMs: 1_000,
            match: { topic: 'forbidden', sinceEpochMs: 1_000 }
        });
        await started.promise;
        runtime.recordEvent({ kind: 'message', topic: 'forbidden', payload: { marker: 'first' } });
        runtime.recordEvent({ kind: 'message', topic: 'forbidden', payload: { marker: 'latest', accessToken: 'secret' } });
        for (let index = 0; index < 10; index++) {
            runtime.recordEvent({ kind: 'event', topic: 'allowed' });
        }
        let settled = false;
        void pending.then(() => {
            settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);
        hold.resolve();
        const result = await pending;
        expect(result.error?.code).toBe('RALLAR_BLACK_BOX_WAIT_ABSENCE_VIOLATED');
        expect(result.value).toMatchObject({ event: { payload: { marker: 'latest', accessToken: '<redacted>' } } });
        expect(now).toBe(2_000);
    });

    it.each([1, 2])('rejects barrier reuse after eviction and permits a fresh lifecycle after reset with %s retained events', async (maxEvents) => {
        const runtime = createDefaultRallarBlackBoxTestRuntime({ eventHistory: { mode: 'recent', maxEvents } });
        const release = runtime.subscribe((state) => {
            const arrived = state.events.at(-1);
            if (arrived?.topic === 'rallar.bb.barrier.arrived') {
                runtime.recordEvent({
                    kind: 'event',
                    topic: 'rallar.bb.barrier.resolved',
                    payload: {
                        barrierId: 'one',
                        resolution: { outcome: 'released', arrivedAgentIds: ['agent'] }
                    }
                });
            }
        });
        try {
            const first = await runtime.execute({ kind: 'barrier', commandId: 'first', barrierId: 'one', timeoutMs: 1 });
            expect(first.status).toBe('ok');
            for (let index = 0; index < 8; index++) {
                runtime.recordEvent({ kind: 'event', topic: 'later' });
            }
            const reused = await runtime.execute({ kind: 'barrier', commandId: 'reuse', barrierId: 'one', timeoutMs: 1 });
            expect(reused.error?.code).toBe('RALLAR_BLACK_BOX_BARRIER_REUSED');
            await runtime.execute({ kind: 'reset', commandId: 'reset' });
            const fresh = await runtime.execute({ kind: 'barrier', commandId: 'fresh', barrierId: 'one', timeoutMs: 1 });
            expect(fresh.status).toBe('ok');
        }
        finally {
            release();
        }
    });

    it('preserves an unavailable-history barrier failure when the selected window is genuinely lost', async () => {
        const runtime = createDefaultRallarBlackBoxTestRuntime({ eventHistory: { mode: 'recent', maxEvents: 1 } });
        const before = runtime.state().eventHistory;
        runtime.recordEvent({ kind: 'event', topic: 'other.1' });
        runtime.recordEvent({ kind: 'event', topic: 'other.2' });
        const after = runtime.state().eventHistory;
        let reads = 0;
        const controller = new AbortController();
        const result = await waitForBarrier({
            command: { kind: 'barrier', commandId: 'lost', barrierId: 'lost', timeoutMs: 1 },
            reserveBarrier: () => true,
            recordEvent: (event) => runtime.recordEvent(event),
            now: Date.now,
            sleep: async () => {},
            cancellationSignal: controller.signal,
            cancelRequested: () => false,
            currentStatus: () => runtime.state().status,
            currentEvents: () => runtime.state().events,
            currentEventHistory: () => reads++ === 0 ? before : after,
            resultCache: {},
            subscribe: (listener) => runtime.subscribe((state) => listener(state.events, state.eventHistory))
        });
        expect(result.error?.code).toBe('RALLAR_BLACK_BOX_HISTORY_UNAVAILABLE');
    });

    it.each(['full', 'recent'] as const)('preserves current lane health in %s Stats after event eviction and clears it on close', async (mode) => {
        const runtime = createDefaultRallarBlackBoxTestRuntime({ eventHistory: mode === 'full' ? { mode } : { mode, maxEvents: 1 } });
        runtime.recordEvent({ kind: 'diagnostic', topic: 'rallar.bb.rtc.connected', payload: { laneHealth: 'open' } });
        for (let index = 0; index < 5; index++) {
            runtime.recordEvent({ kind: 'event', topic: 'other' });
        }
        const healthy = await runtime.execute({ kind: 'stats', commandId: 'healthy' });
        expect(healthy.value).toMatchObject({ rallar: { laneHealth: 'open' } });
        runtime.recordEvent({ kind: 'diagnostic', topic: 'rallar.bb.rtc.connected', payload: { laneHealth: { ready: true } } });
        const ready = await runtime.execute({ kind: 'stats', commandId: 'ready' });
        expect(ready.value).toMatchObject({ rallar: { laneHealth: { ready: true } } });
        await runtime.execute({ kind: 'close', commandId: 'close' });
        const closed = await runtime.execute({ kind: 'stats', commandId: 'closed' });
        expect(closed.value).toMatchObject({ rallar: { connected: false, laneHealth: undefined } });
    });

    it('changes policy while idle without claiming evicted history became available', async () => {
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        for (let index = 0; index < 8; index++) {
            runtime.recordEvent({ kind: 'message', topic: 'history.message' });
        }
        const recent = await runtime.execute({ kind: 'configure', commandId: 'recent', config: { eventHistory: { mode: 'recent', maxEvents: 3 } } });
        expect(recent.status).toBe('ok');
        expect(runtime.state().events).toHaveLength(3);
        expect(runtime.state().eventHistory).toMatchObject({ policy: { mode: 'recent', maxEvents: 3 }, countsByKind: { message: 8 } });

        const full = await runtime.execute({ kind: 'configure', commandId: 'full', config: { eventHistory: { mode: 'full' } } });
        expect(full.status).toBe('ok');
        const unavailable = await runtime.execute({ kind: 'assert', commandId: 'all', source: 'messages.length', operator: 'equals', expected: 0 });
        expect(unavailable.error?.code).toBe('RALLAR_BLACK_BOX_HISTORY_UNAVAILABLE');
        const evicted = runtime.state().eventHistory.evictedEvents;
        await runtime.execute({ kind: 'configure', commandId: 'unrelated', config: { actor: 'alice' } });
        expect(runtime.state().eventHistory).toMatchObject({ policy: { mode: 'full' }, evictedEvents: evicted });
        await runtime.execute({ kind: 'reset', commandId: 'reset-full' });
        expect(runtime.state().eventHistory).toMatchObject({ policy: { mode: 'full' }, evictedEvents: 0 });
    });

    it('rejects a policy change while another operation owns a history window', async () => {
        const started = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const runtime = createDefaultRallarBlackBoxTestRuntime({
            sleep: async () => {
                started.resolve();
                await release.promise;
            }
        });
        const waiting = runtime.execute({ kind: 'wait', commandId: 'pending', absent: true, timeoutMs: 1_000, match: { topic: 'forbidden' } });
        await started.promise;
        const refused = await runtime.execute({ kind: 'configure', commandId: 'refused', config: { eventHistory: { mode: 'recent', maxEvents: 2 } } });
        expect(refused.error?.code).toBe('RALLAR_BLACK_BOX_HISTORY_POLICY_ACTIVE');
        expect(runtime.state().eventHistory.policy).toEqual({ mode: 'full' });
        const unchanged = await runtime.execute({ kind: 'configure', commandId: 'same', config: { eventHistory: { mode: 'full' } } });
        expect(unchanged.status).toBe('ok');
        release.resolve();
        expect((await waiting).status).toBe('ok');
    });

    it('refuses malformed configure limits without changing the retained view', async () => {
        const runtime = createDefaultRallarBlackBoxTestRuntime({ eventHistory: { mode: 'recent', maxEvents: 3 } });
        const result = await runtime.execute({ kind: 'configure', commandId: 'invalid', config: { eventHistory: { mode: 'recent', maxEvents: 0 } } });
        expect(result.error?.code).toBe('RALLAR_BLACK_BOX_HISTORY_POLICY_INVALID');
        expect(runtime.state().eventHistory.policy).toEqual({ mode: 'recent', maxEvents: 3 });
    });

    it('refuses a null policy as a policy failure rather than a runtime exception', async () => {
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        const result = await runtime.execute({
            kind: 'configure',
            commandId: 'null-policy',
            config: {
                // @ts-expect-error Exercise an untrusted JavaScript construction value.
                eventHistory: null
            }
        });
        expect(result.error?.code).toBe('RALLAR_BLACK_BOX_HISTORY_POLICY_INVALID');
    });
});
