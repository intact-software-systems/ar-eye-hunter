import type { Timers } from './timers.ts';

export interface ReadUntilInput<T> {
    readonly timers: Timers;
    /** The wait after a read that was not accepted. */
    readonly intervalMs: number;
    /** On the timers' clock: no read starts at or after it. */
    readonly deadlineAtMs: number;
    readonly read: () => Promise<T>;
    readonly accept: (value: T) => boolean;
}

export interface ReadUntilNarrowingInput<T, A extends T> extends ReadUntilInput<T> {
    readonly accept: (value: T) => value is A;
}

export type ReadUntilOutcome<T> =
    | Readonly<{ kind: 'accepted'; value: T; }>
    | Readonly<{ kind: 'timed-out'; deadlineAtMs: number; }>;

/**
 * Reads until a read is accepted or the deadline passes, one read at a time and the interval after each read it did
 * not accept. A read that started before the deadline is still accepted after it. A read's failure rejects the call
 * and ends the reads: the caller owns it, as it owns its reaction to the timed-out value.
 */
export function readUntil<T, A extends T>(input: ReadUntilNarrowingInput<T, A>): Promise<ReadUntilOutcome<A>>;
export function readUntil<T>(input: ReadUntilInput<T>): Promise<ReadUntilOutcome<T>>;
export async function readUntil<T>(input: ReadUntilInput<T>): Promise<ReadUntilOutcome<T>> {
    if (!Number.isFinite(input.intervalMs) || input.intervalMs <= 0) {
        throw new TypeError('Reading until a deadline requires a positive finite interval');
    }
    while (input.timers.nowMs() < input.deadlineAtMs) {
        const value = await input.read();
        if (input.accept(value)) {
            return { kind: 'accepted', value };
        }
        await new Promise<void>((resolve) => {
            input.timers.schedule(resolve, input.intervalMs);
        });
    }
    return { kind: 'timed-out', deadlineAtMs: input.deadlineAtMs };
}
