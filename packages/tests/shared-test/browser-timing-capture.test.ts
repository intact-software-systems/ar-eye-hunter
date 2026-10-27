import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserTimingCapture } from '../../shared-test/browser-timing-capture.ts';
import { createDefaultTimers } from '../../shared/resilience/timers.ts';

function createProtocolChannel() {
    let detached = false;
    return {
        send: vi.fn(),
        detach: async () => { detached = true; },
        get detached() { return detached; }
    };
}

describe('BrowserTimingCapture', () => {
    afterEach(() => vi.useRealTimers());

    it('records independent numeric renderer and process samples with wall-clock bounds', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        const renderer = createProtocolChannel();
        const browser = createProtocolChannel();
        const observations: BrowserTimingCapture.Observation[] = [];
        renderer.send.mockResolvedValueOnce({}).mockResolvedValue({ metrics: [
            { name: 'TaskDuration', value: 1.25 },
            { name: 'ScriptDuration', value: 0.25 },
            { name: 'JSHeapUsedSize', value: 2048 },
            { name: 'secret-token', value: 99 }
        ] });
        browser.send.mockResolvedValue({ processInfo: [{ id: 42, type: 'GPU', cpuTime: 2.5 }] });
        const capture = new BrowserTimingCapture({ renderer, browser, timers: createDefaultTimers(), record: (sample) => observations.push(sample) });
        await capture.start();
        await vi.advanceTimersByTimeAsync(1000);
        await capture.stop();
        expect(observations).toContainEqual({
            kind: 'renderer', startedAtEpochMs: 1000, completedAtEpochMs: 1000,
            metrics: { TaskDuration: 1.25, ScriptDuration: 0.25, JSHeapUsedSize: 2048 }
        });
        expect(observations).toContainEqual({
            kind: 'processes', startedAtEpochMs: 1000, completedAtEpochMs: 1000,
            processes: [{ id: 42, type: 'GPU', cpuTimeSeconds: 2.5 }]
        });
        expect(JSON.stringify(observations)).not.toContain('secret-token');
        const countAfterStop = observations.length;
        await vi.advanceTimersByTimeAsync(5000);
        expect(observations).toHaveLength(countAfterStop);
        expect(renderer.detached).toBe(true);
        expect(browser.detached).toBe(true);
    });

    it('keeps process evidence when renderer sampling stalls and records the unfinished request at shutdown', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(2000);
        const renderer = createProtocolChannel();
        const browser = createProtocolChannel();
        const observations: BrowserTimingCapture.Observation[] = [];
        renderer.send.mockResolvedValueOnce({}).mockReturnValue(new Promise(() => {}));
        browser.send.mockResolvedValue({ processInfo: [{ id: 7, type: 'GPU', cpuTime: 5 }] });
        const capture = new BrowserTimingCapture({ renderer, browser, timers: createDefaultTimers(), record: (sample) => observations.push(sample) });
        await capture.start();
        await vi.advanceTimersByTimeAsync(3000);
        await capture.stop();
        expect(observations.filter((sample) => sample.kind === 'processes')).toHaveLength(4);
        expect(observations).toContainEqual({ kind: 'incomplete', channel: 'renderer', startedAtEpochMs: 2000, stoppedAtEpochMs: 5000 });
        expect(observations.some((sample) => sample.kind === 'renderer')).toBe(false);
    });


    it('surfaces artifact write failure after detaching both protocol channels', async () => {
        vi.useFakeTimers();
        const renderer = createProtocolChannel();
        const browser = createProtocolChannel();
        renderer.send.mockResolvedValueOnce({}).mockResolvedValue({ metrics: [] });
        browser.send.mockResolvedValue({ processInfo: [] });
        const failure = new Error('artifact storage unavailable');
        const capture = new BrowserTimingCapture({
            renderer, browser, timers: createDefaultTimers(), record: () => { throw failure; }
        });
        await capture.start();
        await vi.advanceTimersByTimeAsync(1);
        await expect(capture.stop()).rejects.toBe(failure);
        expect(renderer.detached).toBe(true);
        expect(browser.detached).toBe(true);
    });

    it('does not publish a late renderer response after shutdown', async () => {
        vi.useFakeTimers();
        const renderer = createProtocolChannel();
        const browser = createProtocolChannel();
        const observations: BrowserTimingCapture.Observation[] = [];
        renderer.send.mockResolvedValueOnce({}).mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ metrics: [] }), 5000)));
        browser.send.mockResolvedValue({ processInfo: [] });
        const capture = new BrowserTimingCapture({ renderer, browser, timers: createDefaultTimers(), record: (sample) => observations.push(sample) });
        await capture.start();
        await vi.advanceTimersByTimeAsync(100);
        await capture.stop();
        const beforeLateResponse = [...observations];
        await vi.advanceTimersByTimeAsync(6000);
        expect(observations).toEqual(beforeLateResponse);
    });

    it('retains a delayed response interval and reports protocol failures without raw error data', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(3000);
        const renderer = createProtocolChannel();
        const browser = createProtocolChannel();
        const observations: BrowserTimingCapture.Observation[] = [];
        renderer.send.mockResolvedValueOnce({}).mockRejectedValue(new Error('secret authorization data'));
        browser.send.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ processInfo: [] }), 1500)));
        const capture = new BrowserTimingCapture({ renderer, browser, timers: createDefaultTimers(), record: (sample) => observations.push(sample) });
        await capture.start();
        await vi.advanceTimersByTimeAsync(1600);
        await capture.stop();
        expect(observations).toContainEqual({ kind: 'failed', channel: 'renderer', startedAtEpochMs: 3000, completedAtEpochMs: 3000 });
        expect(observations).toContainEqual({ kind: 'processes', startedAtEpochMs: 3000, completedAtEpochMs: 4500, processes: [] });
        expect(JSON.stringify(observations)).not.toContain('secret');
    });
});
