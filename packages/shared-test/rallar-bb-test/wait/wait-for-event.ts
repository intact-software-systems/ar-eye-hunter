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

import {
    isEventHistoryCovered,
    toEventHistoryUnavailableOutcome,
    type RallarBlackBoxEventHistory,
    type RallarBlackBoxEventHistorySequence
} from '../runtime/event-history.ts';
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
    /** An owned operation may start a new ordinal window instead of querying all prior payloads. */
    readonly historyStart?: RallarBlackBoxEventHistorySequence;
    readonly now: () => number;
    readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    readonly cancellationSignal: AbortSignal;
    readonly cancelRequested: () => boolean;
    readonly currentStatus: () => RallarBlackBoxTestRuntimeStatus;
    readonly currentEvents: () => readonly RallarBlackBoxTestEvent[];
    readonly currentEventHistory: () => RallarBlackBoxEventHistory;
    readonly resultCache: RallarBlackBoxTestState['resultCache'];
    /** An owned publisher may emit once after the observation and abort boundaries are installed. */
    readonly publishAfterSubscription?: () => void;
    readonly subscribe: (
        listener: (events: readonly RallarBlackBoxTestEvent[], history: RallarBlackBoxEventHistory) => void
    ) => () => void;
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
    if (!isWaitHistoryCovered(input)) {
        return toEventHistoryUnavailableOutcome(input.currentEventHistory());
    }
    const immediate = resolveLatestWaitEvent(toWaitEvents(input, input.currentEvents()), command.match);
    if (immediate && command.absent !== true && input.publishAfterSubscription === undefined) {
        return toWaitMatchedOutcome(command, immediate, input.currentStatus());
    }
    const deadlineEpochMs = computeWaitDeadlineEpochMs(command, input.now());
    if (input.now() >= deadlineEpochMs && command.absent !== true) {
        return toWaitTimedOutOutcome(command, deadlineEpochMs);
    }
    return await new Promise<RallarBlackBoxTestCommandOutcome>((resolve) => {
        new WaitEventSubscription({ input, deadlineEpochMs, latestMatch: immediate }, resolve).start();
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

declare namespace WaitEventSubscription {
    interface Start {
        readonly input: WaitForEventInput;
        readonly deadlineEpochMs: number;
        /** The latest match among the events retained when the wait starts; absent when none matched. */
        readonly latestMatch: RallarBlackBoxTestEvent | undefined;
    }
}

/**
 * Owns one pending wait: its timeout, abort listener and event subscription end together on the first outcome.
 * Each notification examines only the events appended since the previous one, so the latest match stays exact.
 */
class WaitEventSubscription {
    private readonly input: WaitForEventInput;
    private readonly deadlineEpochMs: number;
    private readonly onOutcome: WaitOutcomeListener;
    private latestMatch: RallarBlackBoxTestEvent | undefined;
    private offending: RallarBlackBoxTestEvent | undefined;
    private readonly historyGeneration: number;
    private examinedGeneration: number;
    private examinedTotalEvents: number;
    private historyChanged = false;
    private settled = false;
    private timeout: ReturnType<typeof setTimeout> | undefined;
    private unsubscribe: (() => void) | undefined;
    private unsubscribeOnceSubscribed = false;

    constructor(start: WaitEventSubscription.Start, onOutcome: WaitOutcomeListener) {
        const history = start.input.currentEventHistory();
        this.input = start.input;
        this.deadlineEpochMs = start.deadlineEpochMs;
        this.onOutcome = onOutcome;
        this.historyGeneration = history.generation;
        this.examinedGeneration = history.generation;
        this.examinedTotalEvents = history.totalEvents;
        this.latestMatch = start.latestMatch;
        this.offending = start.latestMatch;
    }

    private readonly onAbort = (): void => {
        this.stopWithOutcome(toWaitCancelledOutcome(this.input.command));
    };

    private readonly onEventsChanged = (
        events: readonly RallarBlackBoxTestEvent[],
        history: RallarBlackBoxEventHistory
    ): void => {
        const { command } = this.input;
        if (this.input.cancelRequested()) {
            this.stopWithOutcome(toWaitCancelledOutcome(command));
            return;
        }
        const matched = this.resolveLatestMatch(events, history);
        if (command.absent === true) {
            this.offending = matched ?? this.offending;
            this.historyChanged ||= history.generation !== this.historyGeneration;
            return;
        }
        if (matched) {
            this.stopWithOutcome(toWaitMatchedOutcome(command, matched, this.input.currentStatus()));
            return;
        }
        if (this.input.now() >= this.deadlineEpochMs) {
            this.stopWithOutcome(toWaitTimedOutOutcome(command, this.deadlineEpochMs));
        }
    };

    /** A new history generation replaces the retained events, so its matches are resolved over all of them. */
    private resolveLatestMatch(
        events: readonly RallarBlackBoxTestEvent[],
        history: RallarBlackBoxEventHistory
    ): RallarBlackBoxTestEvent | undefined {
        if (history.generation !== this.examinedGeneration) {
            this.examinedGeneration = history.generation;
            this.examinedTotalEvents = 0;
            this.latestMatch = undefined;
        }
        const appendedCount = Math.min(events.length, history.totalEvents - this.examinedTotalEvents);
        const appended = appendedCount > 0 ? events.slice(events.length - appendedCount) : [];
        this.examinedTotalEvents = history.totalEvents;
        this.latestMatch = resolveLatestWaitEvent(toWaitEvents(this.input, appended), this.input.command.match) ??
            this.latestMatch;
        return this.latestMatch;
    }

    start(): void {
        const { command, cancellationSignal } = this.input;
        const timeoutDelayMs = Math.max(0, this.deadlineEpochMs - this.input.now());
        if (cancellationSignal.aborted) {
            this.stopWithOutcome(toWaitCancelledOutcome(command));
            return;
        }
        if (command.absent !== true) {
            this.timeout = setTimeout(this.onDeadline, timeoutDelayMs);
        }
        cancellationSignal.addEventListener('abort', this.onAbort, { once: true });
        this.unsubscribe = this.input.subscribe(this.onEventsChanged);
        if (this.unsubscribeOnceSubscribed && this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = undefined;
        }
        this.input.publishAfterSubscription?.();
        if (command.absent === true && !this.settled) {
            void this.input.sleep(Math.max(0, this.deadlineEpochMs - this.input.now()), cancellationSignal)
                .then(this.onDeadline, this.onAbort);
        }
    }

    private readonly onDeadline = (): void => {
        const { command } = this.input;
        if (this.input.cancelRequested()) {
            this.onAbort();
            return;
        }
        if (command.absent !== true) {
            this.stopWithOutcome(toWaitTimedOutOutcome(command, this.deadlineEpochMs));
            return;
        }
        const outcome: RallarBlackBoxTestCommandOutcome = this.offending
            ? toWaitAbsenceViolatedOutcome(command, this.offending, this.deadlineEpochMs)
            : this.historyChanged
            ? toEventHistoryUnavailableOutcome(this.input.currentEventHistory())
            : {
                status: 'ok',
                value: toWaitResultValue(command, { matched: false, absent: true }),
                nextStatus: this.input.currentStatus()
            };
        this.stopWithOutcome(outcome);
    };

    private stopWithOutcome(outcome: RallarBlackBoxTestCommandOutcome): void {
        if (this.settled) {
            return;
        }
        this.settled = true;
        this.stopListening();
        this.offending = undefined;
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

function isWaitHistoryCovered(input: WaitForEventInput): boolean {
    const history = input.currentEventHistory();
    return input.historyStart === undefined
        ? isEventHistoryCovered(history, input.command.match.sinceEpochMs)
        : history.runtimeId === input.historyStart.runtimeId && history.generation === input.historyStart.generation &&
            input.historyStart.ordinal > history.evictedEvents;
}

function toWaitEvents(
    input: WaitForEventInput,
    events: readonly RallarBlackBoxTestEvent[]
): readonly RallarBlackBoxTestEvent[] {
    const start = input.historyStart;
    return start === undefined
        ? events
        : events.filter((event) =>
            event.history?.runtimeId === start.runtimeId && event.history.generation === start.generation &&
            event.history.ordinal >= start.ordinal
        );
}
