import type {
    RallarBlackBoxTestCommandBase,
    RallarBlackBoxTestCommandKind,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestRecord,
    RallarBlackBoxTestRuntimeStatus,
    RallarBlackBoxTestState,
    RallarBlackBoxTestWaitCommand,
    RallarBlackBoxTestWaitResultValue
} from '../rallar-black-box-test-contracts.ts';

import { resolveWaitMatchResultReferences } from './resolve-wait-match-result-references.ts';
import { resolveLatestWaitEvent } from './wait-event-match.ts';

export const RALLAR_BLACK_BOX_WAIT_ABSENCE_VIOLATED = 'RALLAR_BLACK_BOX_WAIT_ABSENCE_VIOLATED';

const DEFAULT_WAIT_TIMEOUT_MS = 5_000;

type WaitCommandWithId = RallarBlackBoxTestWaitCommand & Readonly<{ commandId: string; }>;

type WaitResultFacts = Omit<RallarBlackBoxTestWaitResultValue, 'commandId' | 'match'>;

type WaitOutcomeListener = (outcome: RallarBlackBoxTestCommandOutcome) => void;

/** The timeout and deadline bounds any windowed command shares with the wait command. */
export type RallarBlackBoxTestWaitWindow = Pick<
    RallarBlackBoxTestCommandBase<RallarBlackBoxTestCommandKind>,
    'timeoutMs' | 'deadlineEpochMs'
>;

export interface WaitForEventInput {
    readonly command: WaitCommandWithId;
    readonly now: () => number;
    readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    readonly cancellationSignal: AbortSignal;
    readonly cancelRequested: () => boolean;
    readonly currentStatus: () => RallarBlackBoxTestRuntimeStatus;
    readonly currentEvents: () => readonly RallarBlackBoxTestEvent[];
    readonly resultCache: RallarBlackBoxTestState['resultCache'];
    readonly subscribe: (listener: () => void) => () => void;
}

export async function waitForEvent(
    input: WaitForEventInput
): Promise<RallarBlackBoxTestCommandOutcome> {
    const command = input.command;
    if (!command.match || Object.keys(command.match).length === 0) {
        return toWaitInvalidOutcome(command, 'Wait requires at least one match field.', undefined);
    }
    if (command.absent !== undefined && command.absent !== true) {
        return toWaitInvalidOutcome(command, 'Wait absent must be true when present.', { absent: command.absent });
    }
    if (input.cancelRequested()) {
        return toWaitCancelledOutcome(command);
    }
    return await resolveWaitMatchResultReferences(command.match, input.resultCache).fold(
        async ({ reference }) =>
            toWaitInvalidOutcome(command, 'Wait match references a result value no earlier command returned.', {
                reference
            }),
        async (match) => await waitForResolvedEvent({ ...input, command: { ...command, match } })
    );
}

async function waitForResolvedEvent(input: WaitForEventInput): Promise<RallarBlackBoxTestCommandOutcome> {
    const command = input.command;
    if (command.absent === true) {
        return await waitForEventAbsence(input);
    }

    const immediate = resolveLatestWaitEvent(input.currentEvents(), command.match);
    if (immediate) {
        return toWaitMatchedOutcome(command, immediate, input.currentStatus());
    }
    const deadlineEpochMs = computeWaitDeadlineEpochMs(command, input.now());
    if (input.now() >= deadlineEpochMs) {
        return toWaitTimedOutOutcome(command, deadlineEpochMs);
    }
    return await new Promise<RallarBlackBoxTestCommandOutcome>((resolve) => {
        new WaitEventSubscription(input, deadlineEpochMs, resolve).start();
    });
}

/** Without either bound the default five second timeout applies; with both, the earlier one wins. */
export function computeWaitDeadlineEpochMs(window: RallarBlackBoxTestWaitWindow, nowEpochMs: number): number {
    if (window.timeoutMs === undefined) {
        return window.deadlineEpochMs ?? nowEpochMs + DEFAULT_WAIT_TIMEOUT_MS;
    }
    const timeoutDeadlineEpochMs = nowEpochMs + Math.max(0, window.timeoutMs);
    return window.deadlineEpochMs === undefined
        ? timeoutDeadlineEpochMs
        : Math.min(timeoutDeadlineEpochMs, window.deadlineEpochMs);
}

/** Owns one pending wait: its timeout, abort listener and event subscription end together on the first outcome. */
class WaitEventSubscription {
    private readonly input: WaitForEventInput;
    private readonly deadlineEpochMs: number;
    private readonly onOutcome: WaitOutcomeListener;
    private settled = false;
    private timeout: ReturnType<typeof setTimeout> | undefined;
    private unsubscribe: (() => void) | undefined;
    private unsubscribeOnceSubscribed = false;

    constructor(input: WaitForEventInput, deadlineEpochMs: number, onOutcome: WaitOutcomeListener) {
        this.input = input;
        this.deadlineEpochMs = deadlineEpochMs;
        this.onOutcome = onOutcome;
    }

    private readonly onAbort = (): void => {
        this.stopWithOutcome(toWaitCancelledOutcome(this.input.command));
    };

    private readonly onEventsChanged = (): void => {
        const { command } = this.input;
        if (this.input.cancelRequested()) {
            this.stopWithOutcome(toWaitCancelledOutcome(command));
            return;
        }
        const matched = resolveLatestWaitEvent(this.input.currentEvents(), command.match);
        if (matched) {
            this.stopWithOutcome(toWaitMatchedOutcome(command, matched, this.input.currentStatus()));
            return;
        }
        if (this.input.now() >= this.deadlineEpochMs) {
            this.stopWithOutcome(toWaitTimedOutOutcome(command, this.deadlineEpochMs));
        }
    };

    start(): void {
        const { command, cancellationSignal } = this.input;
        const timeoutDelayMs = Math.max(0, this.deadlineEpochMs - this.input.now());
        if (cancellationSignal.aborted) {
            this.stopWithOutcome(toWaitCancelledOutcome(command));
            return;
        }
        this.timeout = setTimeout(() => {
            this.stopWithOutcome(toWaitTimedOutOutcome(command, this.deadlineEpochMs));
        }, timeoutDelayMs);
        cancellationSignal.addEventListener('abort', this.onAbort, { once: true });
        this.unsubscribe = this.input.subscribe(this.onEventsChanged);
        if (this.unsubscribeOnceSubscribed && this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = undefined;
        }
    }

    private stopWithOutcome(outcome: RallarBlackBoxTestCommandOutcome): void {
        if (this.settled) {
            return;
        }
        this.settled = true;
        this.stopListening();
        this.onOutcome(outcome);
    }

    /** A wait can settle while subscribe is still running, before its unsubscribe exists. */
    private stopListening(): void {
        if (this.timeout) {
            clearTimeout(this.timeout);
            this.timeout = undefined;
        }
        this.input.cancellationSignal.removeEventListener('abort', this.onAbort);
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = undefined;
        }
        else {
            this.unsubscribeOnceSubscribed = true;
        }
    }
}

// Parity with runner absence waits: the full window is always held —
// an absence claim is only as strong as the time the agent kept listening —
// then the whole buffer is scanned once, so earlier events violate by design.
async function waitForEventAbsence(
    input: WaitForEventInput
): Promise<RallarBlackBoxTestCommandOutcome> {
    const command = input.command;
    const deadlineEpochMs = computeWaitDeadlineEpochMs(command, input.now());

    try {
        await input.sleep(Math.max(0, deadlineEpochMs - input.now()), input.cancellationSignal);
    }
    catch (_error) {
        return toWaitCancelledOutcome(command);
    }
    if (input.cancelRequested()) {
        return toWaitCancelledOutcome(command);
    }

    const offending = resolveLatestWaitEvent(input.currentEvents(), command.match);
    if (offending) {
        return toWaitAbsenceViolatedOutcome(command, offending, deadlineEpochMs);
    }

    return {
        status: 'ok',
        value: toWaitResultValue(command, { matched: false, absent: true }),
        nextStatus: input.currentStatus()
    };
}

function toWaitResultValue(command: WaitCommandWithId, facts: WaitResultFacts): RallarBlackBoxTestWaitResultValue {
    return {
        commandId: command.commandId,
        match: command.match,
        ...facts
    };
}

function toWaitMatchedOutcome(
    command: WaitCommandWithId,
    event: RallarBlackBoxTestEvent,
    nextStatus: RallarBlackBoxTestRuntimeStatus
): RallarBlackBoxTestCommandOutcome {
    return {
        status: 'ok',
        value: toWaitResultValue(command, { matched: true, event }),
        nextStatus
    };
}

function toWaitAbsenceViolatedOutcome(
    command: WaitCommandWithId,
    event: RallarBlackBoxTestEvent,
    deadlineEpochMs: number
): RallarBlackBoxTestCommandOutcome {
    return {
        status: 'failed',
        value: toWaitResultValue(command, { matched: true, absent: true, event }),
        error: {
            code: RALLAR_BLACK_BOX_WAIT_ABSENCE_VIOLATED,
            message: 'Wait absence was violated: a runtime event matched before the window closed.',
            details: {
                timeoutMs: command.timeoutMs,
                deadlineEpochMs,
                match: command.match,
                event
            }
        },
        nextStatus: 'failed'
    };
}

function toWaitTimedOutOutcome(
    command: WaitCommandWithId,
    deadlineEpochMs: number
): RallarBlackBoxTestCommandOutcome {
    return {
        status: 'failed',
        value: toWaitResultValue(command, { matched: false, timedOut: true }),
        error: {
            code: 'RALLAR_BLACK_BOX_WAIT_TIMEOUT',
            message: 'Wait command timed out before matching a runtime event.',
            details: {
                timeoutMs: command.timeoutMs,
                deadlineEpochMs,
                match: command.match
            }
        },
        nextStatus: 'failed'
    };
}

function toWaitCancelledOutcome(command: WaitCommandWithId): RallarBlackBoxTestCommandOutcome {
    return {
        status: 'cancelled',
        value: toWaitResultValue(command, {
            matched: false,
            ...(command.absent === true ? { absent: true } : {}),
            cancelled: true
        }),
        nextStatus: 'cancelled'
    };
}

function toWaitInvalidOutcome(
    command: WaitCommandWithId,
    message: string,
    details: RallarBlackBoxTestRecord | undefined
): RallarBlackBoxTestCommandOutcome {
    return {
        status: 'failed',
        value: toWaitResultValue(command, { matched: false }),
        error: {
            code: 'RALLAR_BLACK_BOX_WAIT_INVALID',
            message,
            details
        },
        nextStatus: 'failed'
    };
}
