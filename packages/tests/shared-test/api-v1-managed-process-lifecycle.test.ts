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
        });

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
});
