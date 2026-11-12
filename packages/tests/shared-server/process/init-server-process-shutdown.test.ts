import { describe, expect, it } from 'vitest';

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

describe('initServerProcessShutdown', () => {
    it('exits 0 only after the graceful stop resolves', async () => {
        const process = new RecordingProcess();
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
            log: silent
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
        initServerProcessShutdown({
            process,
            signals: ['SIGINT'],
            stop: () => Promise.reject(new Error('drain failed')),
            log: silent
        });

        process.send('SIGINT');
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(process.exits).toEqual([1]);
    });

    it('forces exit 1 on a second signal without starting a second stop', () => {
        const process = new RecordingProcess();
        const stops: string[] = [];
        initServerProcessShutdown({
            process,
            signals: ['SIGTERM', 'SIGINT'],
            stop: () => {
                stops.push('stop');
                return new Promise(() => undefined);
            },
            log: silent
        });

        process.send('SIGTERM');
        process.send('SIGINT');

        expect({ stops, exits: process.exits }).toEqual({ stops: ['stop'], exits: [1] });
    });
});
