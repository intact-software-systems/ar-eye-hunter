import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Timers } from '@shared/resilience/timers.ts';

import { initServerProcessShutdown, type ServerProcessSignal } from '@shared-server/process/init-server-process-shutdown.ts';

class RecordingProcess {
    readonly listeners = new Map<ServerProcessSignal, () => void>();
    readonly exits: number[] = [];

    on(signal: ServerProcessSignal, listener: () => void): void {
        this.listeners.set(signal, listener);
    }

    exit(code: number): void {
        this.exits.push(code);
    }

    send(signal: ServerProcessSignal): void {
        this.listeners.get(signal)?.();
    }
}

const silent = { log: () => undefined, error: () => undefined };

/** A settable clock over the (possibly faked) global timers. */
class ManualClock implements Timers {
    epochMs = 1_000;
    readonly nowMs = (): number => this.epochMs;

    schedule(run: () => void, delayMs: number): () => void {
        const handle = setTimeout(run, delayMs);
        return () => clearTimeout(handle);
    }
}

describe('initServerProcessShutdown', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('exits 1 at the deadline when the ordered stop never finishes', async () => {
        vi.useFakeTimers();
        const process = new RecordingProcess();
        const clock = new ManualClock();
        initServerProcessShutdown({
            process,
            signals: ['SIGTERM'],
            stop: () => new Promise(() => undefined),
            log: silent,
            timers: clock,
            deadlineMs: 5_000
        });

        process.send('SIGTERM');
        await vi.advanceTimersByTimeAsync(4_999);
        expect(process.exits).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);

        expect(process.exits).toEqual([1]);
    });

    it('exits 0 only after the graceful stop resolves', async () => {
        const process = new RecordingProcess();
        const clock = new ManualClock();
        const effects: string[] = [];
        let finishStop!: () => void;
        initServerProcessShutdown({
            process,
            signals: ['SIGTERM', 'SIGINT'],
            stop: () => {
                effects.push('stop-started');
                return new Promise((resolve) => {
                    finishStop = resolve;
                });
            },
            log: silent,
            timers: clock,
            deadlineMs: 60_000
        });

        process.send('SIGTERM');
        await Promise.resolve();
        expect({ effects, exits: process.exits }).toEqual({ effects: ['stop-started'], exits: [] });

        finishStop();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(process.exits).toEqual([0]);
    });

    it('exits 1 when a stop step failed', async () => {
        const process = new RecordingProcess();
        const clock = new ManualClock();
        initServerProcessShutdown({
            process,
            signals: ['SIGINT'],
            stop: () => Promise.reject(new Error('drain failed')),
            log: silent,
            timers: clock,
            deadlineMs: 60_000
        });

        process.send('SIGINT');
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(process.exits).toEqual([1]);
    });

    it('treats a stop that throws before returning its promise as a failed stop', async () => {
        const process = new RecordingProcess();
        const clock = new ManualClock();
        initServerProcessShutdown({
            process,
            signals: ['SIGTERM'],
            stop: () => {
                throw new Error('stop step threw synchronously');
            },
            log: silent,
            timers: clock,
            deadlineMs: 60_000
        });

        expect(() => process.send('SIGTERM')).not.toThrow();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(process.exits).toEqual([1]);
    });

    it('forces exit 1 on a second signal without starting a second stop', async () => {
        const process = new RecordingProcess();
        const clock = new ManualClock();
        const stops: string[] = [];
        initServerProcessShutdown({
            process,
            signals: ['SIGTERM', 'SIGINT'],
            stop: () => {
                stops.push('stop');
                return new Promise(() => undefined);
            },
            log: silent,
            timers: clock,
            deadlineMs: 60_000
        });

        process.send('SIGTERM');
        await Promise.resolve();
        clock.epochMs += 1_000;
        process.send('SIGINT');
        await Promise.resolve();

        expect({ stops, exits: process.exits }).toEqual({ stops: ['stop'], exits: [1] });
    });

    it('treats a repeat delivered within a second, as Ctrl+C under npm delivers SIGINT twice, as the same request', async () => {
        const process = new RecordingProcess();
        const clock = new ManualClock();
        const stops: string[] = [];
        let finishStop!: () => void;
        initServerProcessShutdown({
            process,
            signals: ['SIGINT'],
            stop: () => {
                stops.push('stop');
                return new Promise((resolve) => {
                    finishStop = resolve;
                });
            },
            log: silent,
            timers: clock,
            deadlineMs: 60_000
        });

        process.send('SIGINT');
        await Promise.resolve();
        clock.epochMs += 999;
        process.send('SIGINT');
        await Promise.resolve();
        expect({ stops, exits: process.exits }).toEqual({ stops: ['stop'], exits: [] });

        finishStop();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(process.exits).toEqual([0]);
    });
});
