import type {
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestRuntimeStatus,
    RallarBlackBoxTestWaitCommand,
    RallarBlackBoxTestWaitResultValue,
} from '../types.ts';

import { findWaitEvent } from './wait-event-match.ts';

export const RALLAR_BLACK_BOX_WAIT_ABSENCE_VIOLATED = 'RALLAR_BLACK_BOX_WAIT_ABSENCE_VIOLATED';

const DEFAULT_WAIT_TIMEOUT_MS = 5_000;

type WaitCommandWithId = RallarBlackBoxTestWaitCommand & Readonly<{ commandId: string }>;

export interface WaitForEventInput {
    readonly command: WaitCommandWithId;
    readonly now: () => number;
    readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    readonly cancellationSignal: AbortSignal;
    readonly cancelRequested: () => boolean;
    readonly currentStatus: () => RallarBlackBoxTestRuntimeStatus;
    readonly currentEvents: () => readonly RallarBlackBoxTestEvent[];
    readonly subscribe: (listener: () => void) => () => void;
}

export async function waitForEvent(
    input: WaitForEventInput,
): Promise<RallarBlackBoxTestCommandOutcome> {
    const command = input.command;
    if (!command.match || Object.keys(command.match).length === 0) {
        return waitInvalid(command, 'Wait requires at least one match field.');
    }
    if (command.absent !== undefined && command.absent !== true) {
        return waitInvalid(command, 'Wait absent must be true when present.', {
            absent: command.absent,
        });
    }

    if (input.cancelRequested()) {
        return waitCancelled(command);
    }

    if (command.absent === true) {
        return await holdForEventAbsence(input);
    }

    const immediate = findWaitEvent(input.currentEvents(), command.match);
    if (immediate) {
        return waitMatched(command, immediate, input.currentStatus());
    }

    const deadlineEpochMs = waitDeadlineEpochMs(command, input.now);
    if (input.now() >= deadlineEpochMs) {
        return waitTimedOut(command, deadlineEpochMs);
    }

    return await new Promise<RallarBlackBoxTestCommandOutcome>((resolve) => {
        let settled = false;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let unsubscribe: (() => void) | undefined;
        let cleanupAfterSubscribe = false;
        const signal = input.cancellationSignal;

        const cleanup = () => {
            if (timeout) {
                clearTimeout(timeout);
                timeout = undefined;
            }
            signal.removeEventListener('abort', onAbort);
            if (unsubscribe) {
                unsubscribe();
                unsubscribe = undefined;
            } else {
                cleanupAfterSubscribe = true;
            }
        };

        const settle = (outcome: RallarBlackBoxTestCommandOutcome) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve(outcome);
        };

        const evaluate = () => {
            if (input.cancelRequested()) {
                settle(waitCancelled(command));
                return;
            }

            const matched = findWaitEvent(input.currentEvents(), command.match);
            if (matched) {
                settle(waitMatched(command, matched, input.currentStatus()));
                return;
            }

            if (input.now() >= deadlineEpochMs) {
                settle(waitTimedOut(command, deadlineEpochMs));
            }
        };

        const timeoutDelayMs = Math.max(0, deadlineEpochMs - input.now());
        const onAbort = () => {
            settle(waitCancelled(command));
        };
        if (signal.aborted) {
            settle(waitCancelled(command));
            return;
        }
        timeout = setTimeout(() => {
            settle(waitTimedOut(command, deadlineEpochMs));
        }, timeoutDelayMs);
        signal.addEventListener('abort', onAbort, {
            once: true,
        });
        unsubscribe = input.subscribe(evaluate);
        if (cleanupAfterSubscribe && unsubscribe) {
            unsubscribe();
            unsubscribe = undefined;
        }
    });
}

// Parity with the runner's absence waits: the full window is always held —
// an absence claim is only as strong as the time the agent kept listening —
// then the whole buffer is scanned once, so earlier events violate by design.
async function holdForEventAbsence(
    input: WaitForEventInput,
): Promise<RallarBlackBoxTestCommandOutcome> {
    const command = input.command;
    const deadlineEpochMs = waitDeadlineEpochMs(command, input.now);

    try {
        await input.sleep(Math.max(0, deadlineEpochMs - input.now()), input.cancellationSignal);
    } catch (_error) {
        return waitCancelled(command);
    }
    if (input.cancelRequested()) {
        return waitCancelled(command);
    }

    const offending = findWaitEvent(input.currentEvents(), command.match);
    if (offending) {
        return waitAbsenceViolated(command, offending, deadlineEpochMs);
    }

    return {
        status: 'ok',
        value: toWaitResultValue(command, {
            matched: false,
            absent: true,
        }),
        nextStatus: input.currentStatus(),
    };
}

function waitDeadlineEpochMs(command: WaitCommandWithId, now: () => number): number {
    const timeoutMs = command.timeoutMs === undefined
        ? command.deadlineEpochMs === undefined
            ? DEFAULT_WAIT_TIMEOUT_MS
            : undefined
        : Math.max(0, command.timeoutMs);
    const timeoutDeadline = timeoutMs === undefined
        ? undefined
        : now() + timeoutMs;

    if (command.deadlineEpochMs === undefined) {
        return timeoutDeadline ?? (now() + DEFAULT_WAIT_TIMEOUT_MS);
    }

    return timeoutDeadline === undefined
        ? command.deadlineEpochMs
        : Math.min(timeoutDeadline, command.deadlineEpochMs);
}

function toWaitResultValue(
    command: WaitCommandWithId,
    partial: Readonly<{
        matched: boolean;
        absent?: true;
        timedOut?: boolean;
        cancelled?: boolean;
        event?: RallarBlackBoxTestEvent;
    }>,
): RallarBlackBoxTestWaitResultValue {
    return {
        commandId: command.commandId,
        match: command.match,
        ...partial,
    };
}

function waitMatched(
    command: WaitCommandWithId,
    event: RallarBlackBoxTestEvent,
    nextStatus: RallarBlackBoxTestRuntimeStatus,
): RallarBlackBoxTestCommandOutcome {
    return {
        status: 'ok',
        value: toWaitResultValue(command, {
            matched: true,
            event,
        }),
        nextStatus,
    };
}

function waitAbsenceViolated(
    command: WaitCommandWithId,
    event: RallarBlackBoxTestEvent,
    deadlineEpochMs: number,
): RallarBlackBoxTestCommandOutcome {
    return {
        status: 'failed',
        value: toWaitResultValue(command, {
            matched: true,
            absent: true,
            event,
        }),
        error: {
            code: RALLAR_BLACK_BOX_WAIT_ABSENCE_VIOLATED,
            message: 'Wait absence was violated: a runtime event matched before the window closed.',
            details: {
                timeoutMs: command.timeoutMs,
                deadlineEpochMs,
                match: command.match,
                event,
            },
        },
        nextStatus: 'failed',
    };
}

function waitTimedOut(
    command: WaitCommandWithId,
    deadlineEpochMs: number,
): RallarBlackBoxTestCommandOutcome {
    return {
        status: 'failed',
        value: toWaitResultValue(command, {
            matched: false,
            timedOut: true,
        }),
        error: {
            code: 'RALLAR_BLACK_BOX_WAIT_TIMEOUT',
            message: 'Wait command timed out before matching a runtime event.',
            details: {
                timeoutMs: command.timeoutMs,
                deadlineEpochMs,
                match: command.match,
            },
        },
        nextStatus: 'failed',
    };
}

function waitCancelled(command: WaitCommandWithId): RallarBlackBoxTestCommandOutcome {
    return {
        status: 'cancelled',
        value: toWaitResultValue(command, {
            matched: false,
            ...(command.absent === true ? { absent: true } : {}),
            cancelled: true,
        }),
        nextStatus: 'cancelled',
    };
}

function waitInvalid(
    command: WaitCommandWithId,
    message: string,
    details?: unknown,
): RallarBlackBoxTestCommandOutcome {
    return {
        status: 'failed',
        value: toWaitResultValue(command, {
            matched: false,
        }),
        error: {
            code: 'RALLAR_BLACK_BOX_WAIT_INVALID',
            message,
            details,
        },
        nextStatus: 'failed',
    };
}
