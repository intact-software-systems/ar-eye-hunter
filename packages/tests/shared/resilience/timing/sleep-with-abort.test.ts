import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sleepWithAbort } from '@shared/resilience/timing/sleep-with-abort.ts';

const toAbortReason = (signal: AbortSignal) => new Error(`aborted: ${String(signal.reason)}`);

describe('sleep with abort', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('resolves at once for zero ms even when aborted', async () => {
        const controller = new AbortController();
        controller.abort('gone');

        await expect(sleepWithAbort(0, controller.signal, toAbortReason)).resolves.toBeUndefined();
        await expect(sleepWithAbort(-1, controller.signal, toAbortReason)).resolves.toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects at once through the mapping when already aborted', async () => {
        const controller = new AbortController();
        controller.abort('gone');

        await expect(sleepWithAbort(10, controller.signal, toAbortReason)).rejects.toEqual(new Error('aborted: gone'));
        expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects through the mapping when aborted during the wait and clears its timer', async () => {
        const controller = new AbortController();
        const sleeping = sleepWithAbort(10, controller.signal, toAbortReason);

        expect(vi.getTimerCount()).toBe(1);
        controller.abort('during');

        await expect(sleeping).rejects.toEqual(new Error('aborted: during'));
        expect(vi.getTimerCount()).toBe(0);
    });

    it('removes its listener once it resolves', async () => {
        const controller = new AbortController();
        const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener');
        const sleeping = sleepWithAbort(10, controller.signal, toAbortReason);

        await vi.advanceTimersByTimeAsync(10);
        await expect(sleeping).resolves.toBeUndefined();

        expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));
        controller.abort('after');
        expect(vi.getTimerCount()).toBe(0);
    });
});
