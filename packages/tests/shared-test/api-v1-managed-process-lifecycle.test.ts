import { describe, expect, it, vi } from 'vitest';

import { stopManagedApiServer } from '@shared-test/black-box-runner/managed-api/api-v1-managed-process-lifecycle.mts';

describe('managed API-v1 process lifecycle', () => {
    it('kills a child that ignores SIGTERM and fails the stop, because a graceful exit is the contract', async () => {
        vi.useFakeTimers();
        const signals: ('SIGTERM' | 'SIGKILL')[] = [];
        let resolveStatus!: (
            status: Readonly<{ success: boolean; code: number; signal: NodeJS.Signals | null; }>
        ) => void;
        const status = new Promise<Readonly<{ success: boolean; code: number; signal: NodeJS.Signals | null; }>>(
            (resolve) => {
                resolveStatus = resolve;
            }
        );

        const stopping = stopManagedApiServer({
            stdout: null,
            stderr: null,
            status,
            kill(signo): void {
                if (signo !== 'SIGTERM' && signo !== 'SIGKILL') {
                    throw new Error(`Unexpected managed API signal: ${String(signo)}`);
                }
                signals.push(signo);
                if (signo === 'SIGKILL') {
                    resolveStatus({ success: false, code: 137, signal: signo });
                }
            }
        }, 'graceful');

        try {
            expect(signals).toEqual(['SIGTERM']);
            const outcome = stopping.then(() => 'stopped', (error: Error) => error.message);
            await vi.advanceTimersByTimeAsync(5000);

            expect(await outcome).toBe('Managed API-v1 did not exit within 5000 ms of SIGTERM and was killed.');
            expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
        }
        finally {
            vi.useRealTimers();
        }
    });

    it('crashes a child with SIGKILL at once when the proof is about abrupt process death', async () => {
        const child = new RecordingChild();

        await stopManagedApiServer(child, 'crash');

        expect(child.signals).toEqual(['SIGKILL']);
    });

    it('fails a graceful stop whose process exits non-zero', async () => {
        const child = new RecordingChild({ exitCodeOnSigterm: 1 });

        const outcome = await stopManagedApiServer(child, 'graceful').then(() => 'stopped', (error: Error) => error.message);

        expect({ outcome, signals: child.signals }).toEqual({
            outcome: 'Managed API-v1 exited 1 after SIGTERM instead of 0.',
            signals: ['SIGTERM']
        });
    });
});

type ManagedStatus = Readonly<{ success: boolean; code: number; signal: NodeJS.Signals | null; }>;

class RecordingChild {
    readonly stdout = null;
    readonly stderr = null;
    readonly signals: NodeJS.Signals[] = [];
    readonly status: Promise<ManagedStatus>;
    readonly #exitCodeOnSigterm: number;
    #resolve!: (status: ManagedStatus) => void;

    constructor(options: Readonly<{ exitCodeOnSigterm?: number; }> = {}) {
        this.#exitCodeOnSigterm = options.exitCodeOnSigterm ?? 0;
        this.status = new Promise((resolve) => {
            this.#resolve = resolve;
        });
    }

    kill(signo: NodeJS.Signals = 'SIGTERM'): void {
        this.signals.push(signo);
        const code = signo === 'SIGKILL' ? 137 : this.#exitCodeOnSigterm;
        this.#resolve({ success: code === 0, code, signal: null });
    }
}
