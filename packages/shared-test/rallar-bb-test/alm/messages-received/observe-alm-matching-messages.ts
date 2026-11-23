import type {
    RallarBlackBoxTestCommandContext,
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestRecord
} from '../../rallar-black-box-test-contracts.ts';
import { decodeAlmRuntimeRecord } from '../decode-alm-runtime-record.ts';

export namespace ObserveAlmMatchingMessages {
    /** The clock and the abortable sleep the browser adapter binds. */
    export interface Port {
        readonly now: () => number;
        readonly sleep: (ms: number) => Promise<void>;
        readonly withAbort: <T>(operation: Promise<T>, signal: AbortSignal | undefined) => Promise<T>;
    }

    export interface Match {
        readonly connection: string;
        readonly typeId: string;
        readonly msgId: string | undefined;
    }

    export interface Input {
        readonly port: Port;
        readonly context: RallarBlackBoxTestCommandContext;
        readonly holdFullWindow: boolean;
        readonly count: number;
        readonly match: Match;
        readonly deadlineEpochMs: number;
        /** `undefined` when only the deadline ends the observation. */
        readonly stallMs: number | undefined;
        readonly signal: AbortSignal | undefined;
    }

    export interface Result {
        /** Each matched inbound event's message `data`, in arrival order. */
        readonly copies: readonly RallarBlackBoxTestRecord[];
        /** Whether the stall window ended the observation before its deadline. */
        readonly stalled: boolean;
    }
}

const ALM_INBOUND_MESSAGE_TOPICS: readonly string[] = [
    'rallar.browser.ws.message',
    'rallar.browser.messages.rtc.message'
];

const ALM_RECEIVED_POLL_INTERVAL_MS = 10;

/**
 * Parity with the wait command: an absence claim holds the whole window and only then scans the
 * buffer, while a presence claim settles as soon as the recipe's count is on the log. Each poll
 * tick races the abort signal, so a recipe cancellation interrupts the hold instead of always
 * running the full window. A stall window ends a presence claim early once that long passed with
 * no new copy since the observation started or since its latest copy.
 */
export async function observeAlmMatchingMessages(
    input: ObserveAlmMatchingMessages.Input
): Promise<ObserveAlmMatchingMessages.Result> {
    let copies = resolveAlmMatchingMessages(input.context.state().events, input.match);
    let progressEpochMs = input.port.now();
    while (input.port.now() < input.deadlineEpochMs) {
        if (!input.holdFullWindow && copies.length >= input.count) {
            return { copies, stalled: false };
        }
        if (input.stallMs !== undefined && input.port.now() - progressEpochMs >= input.stallMs) {
            return { copies, stalled: true };
        }
        const remainingMs = input.deadlineEpochMs - input.port.now();
        await input.port.withAbort(
            input.port.sleep(Math.min(ALM_RECEIVED_POLL_INTERVAL_MS, remainingMs)),
            input.signal
        );
        const observed = resolveAlmMatchingMessages(input.context.state().events, input.match);
        progressEpochMs = observed.length > copies.length ? input.port.now() : progressEpochMs;
        copies = observed;
    }
    return { copies, stalled: false };
}

function resolveAlmMatchingMessages(
    events: readonly RallarBlackBoxTestEvent[],
    match: ObserveAlmMatchingMessages.Match
): readonly RallarBlackBoxTestRecord[] {
    return events.flatMap((event) => {
        if (
            !ALM_INBOUND_MESSAGE_TOPICS.includes(event.topic) ||
            (event.connection !== undefined && event.connection !== match.connection)
        ) {
            return [];
        }
        const data = decodeAlmRuntimeRecord(decodeAlmRuntimeRecord(event.payload).data);
        const matches = toAlmEventStringField(data, 'typeId') === match.typeId &&
            (match.msgId === undefined || toAlmEventStringField(data, 'msgId') === match.msgId);
        return matches ? [data] : [];
    });
}

function toAlmEventStringField(record: RallarBlackBoxTestRecord, key: string): string {
    const value = record[key];
    return typeof value === 'string' ? value : '';
}
