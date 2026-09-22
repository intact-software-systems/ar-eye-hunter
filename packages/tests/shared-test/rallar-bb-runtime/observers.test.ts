import { setImmediate } from 'node:timers/promises';

import { describe, expect, it, vi } from 'vitest';

import type { RallarBlackBoxTestState } from '../../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createRallarBlackBoxTestRuntime } from '../../../shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';

describe('runtime state observer isolation', () => {
    it.each([
        { delivery: 'initial', failure: 'throw' },
        { delivery: 'initial', failure: 'reject' },
        { delivery: 'later', failure: 'throw' },
        { delivery: 'later', failure: 'reject' }
    ])('isolates $failure on $delivery delivery and retains healthy subscriptions', async ({ delivery, failure }) => {
        const runtime = createRallarBlackBoxTestRuntime();
        const unhandled: unknown[] = [];
        const snapshots: RallarBlackBoxTestState[] = [];
        const failingSnapshots: RallarBlackBoxTestState[] = [];
        const recordUnhandled = (reason: unknown) => {
            unhandled.push(reason);
        };
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        process.on('unhandledRejection', recordUnhandled);
        try {
            const unsubscribeFailing = runtime.subscribe((state) => {
                failingSnapshots.push(state);
                if ((delivery === 'initial') !== (state.commandHistory.length === 0 && state.status === 'idle')) {
                    return;
                }
                const error = new Error('observer failed');
                if (failure === 'throw') {
                    throw error;
                }
                return Promise.reject(error);
            });
            const unsubscribeHealthy = runtime.subscribe((state) => {
                snapshots.push(state);
            });
            expect(snapshots[0].status).toBe('idle');
            const result = await runtime.execute({ kind: 'health', commandId: 'observed' });
            expect(result.status).toBe('ok');
            expect(snapshots.at(-1)?.commandHistory).toContainEqual(result);
            expect(failingSnapshots.at(-1)?.commandHistory).toContainEqual(result);
            await setImmediate();
            expect(unhandled).toEqual([]);

            unsubscribeFailing();
            unsubscribeHealthy();
            const afterUnsubscribe = [...snapshots];
            const failingAfterUnsubscribe = [...failingSnapshots];
            await runtime.execute({ kind: 'health', commandId: 'unobserved' });
            expect(snapshots).toEqual(afterUnsubscribe);
            expect(failingSnapshots).toEqual(failingAfterUnsubscribe);
        }
        finally {
            process.off('unhandledRejection', recordUnhandled);
            consoleError.mockRestore();
        }
    });

    it('finishes commands while an observer remains pending', async () => {
        const pending = Promise.withResolvers<void>();
        const runtime = createRallarBlackBoxTestRuntime();
        const unsubscribe = runtime.subscribe(() => pending.promise);
        try {
            const result = await runtime.execute({ kind: 'health' });
            expect(result.status).toBe('ok');
            expect(runtime.state().commandHistory).toContainEqual(result);
        }
        finally {
            unsubscribe();
            pending.resolve();
        }
    });
});
