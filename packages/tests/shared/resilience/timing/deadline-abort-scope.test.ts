import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DeadlineAbortScope } from '@shared/resilience/timing/deadline-abort-scope.ts';

function createScope(parentSignal: AbortSignal | undefined, timeoutMs: number | undefined): DeadlineAbortScope<Error> {
    return new DeadlineAbortScope({
        parentSignal,
        timeoutMs,
        toParentReason: (signal) => new Error(`parent: ${String(signal.reason)}`),
        toTimeoutReason: () => new Error('deadline')
    });
}

describe('deadline abort scope', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('aborts at once from a parent already aborted', () => {
        const parent = new AbortController();
        parent.abort('gone');

        const scope = createScope(parent.signal, 50);

        expect(scope.signal.aborted).toBe(true);
        expect(scope.origin()).toBe('parent');
        expect(scope.signal.reason).toEqual(new Error('parent: gone'));
        // A parent abort at construction arms no deadline, so the scope can never later report it reached.
        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(50);
        expect(scope.deadlineReached()).toBe(false);
    });

    it('aborts when the parent aborts later', () => {
        const parent = new AbortController();
        const scope = createScope(parent.signal, 50);

        parent.abort('later');

        expect(scope.signal.aborted).toBe(true);
        expect(scope.origin()).toBe('parent');
        expect(scope.signal.reason).toEqual(new Error('parent: later'));
        expect(scope.deadlineReached()).toBe(false);
    });

    it('aborts at its deadline', () => {
        const scope = createScope(undefined, 50);

        vi.advanceTimersByTime(49);
        expect(scope.signal.aborted).toBe(false);
        expect(scope.origin()).toBeUndefined();

        vi.advanceTimersByTime(1);
        expect(scope.signal.aborted).toBe(true);
        expect(scope.origin()).toBe('timeout');
        expect(scope.signal.reason).toEqual(new Error('deadline'));
        expect(scope.deadlineReached()).toBe(true);
    });

    it('keeps the first abort', () => {
        const parent = new AbortController();
        const scope = createScope(parent.signal, 50);
        const reason = new Error('caller');

        scope.abort(reason);
        parent.abort('second');
        vi.advanceTimersByTime(50);

        expect(scope.origin()).toBe('caller');
        expect(scope.signal.reason).toBe(reason);
        expect(scope.deadlineReached()).toBe(true);
    });

    it('cleanup detaches the parent and clears the timer', () => {
        const parent = new AbortController();
        const scope = createScope(parent.signal, 50);

        scope.cleanup();
        scope.cleanup();
        parent.abort('after cleanup');
        vi.advanceTimersByTime(50);

        expect(scope.signal.aborted).toBe(false);
        expect(scope.origin()).toBeUndefined();
        expect(scope.deadlineReached()).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });
});
