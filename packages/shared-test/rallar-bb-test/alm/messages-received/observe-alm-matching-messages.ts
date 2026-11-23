import type {
    RallarBlackBoxTestCommandContext,
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestRecord
} from '../../rallar-black-box-test-contracts.ts';
import { decodeAlmRuntimeRecord } from '../decode-alm-runtime-record.ts';

/** The clock and the abortable sleep the browser adapter binds. */
export interface AlmMatchingMessagesPort {
    readonly now: () => number;
    readonly sleep: (ms: number) => Promise<void>;
    readonly withAbort: <T>(operation: Promise<T>, signal: AbortSignal | undefined) => Promise<T>;
}

export interface AlmReceivedMessageMatch {
    readonly connection: string;
    readonly typeId: string;
    readonly msgId: string | undefined;
}

export interface ObserveAlmMatchingMessagesInput {
    readonly port: AlmMatchingMessagesPort;
    readonly context: RallarBlackBoxTestCommandContext;
    readonly holdFullWindow: boolean;
    readonly count: number;
    readonly match: AlmReceivedMessageMatch;
    readonly deadlineEpochMs: number;
    /** `undefined` when only the deadline ends the observation. */
    readonly stallMs: number | undefined;
    readonly signal: AbortSignal | undefined;
}

export interface AlmMatchingMessages {
    /** Each matched inbound event's message `data`, in arrival order. */
    readonly copies: readonly RallarBlackBoxTestRecord[];
    /** Whether the stall window ended the observation before its deadline. */
    readonly stalled: boolean;
}

/** The retained matching copies, and the event id of the newest, which a recent history keeps however many it evicts. */
interface AlmMatchingCopies {
    readonly copies: readonly RallarBlackBoxTestRecord[];
    readonly newestEventId: string | undefined;
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
 * no new matching copy since the observation started or since its latest copy.
 */
export async function observeAlmMatchingMessages(input: ObserveAlmMatchingMessagesInput): Promise<AlmMatchingMessages> {
    let matching = resolveAlmMatchingCopies(input.context.state().events, input.match);
    let progressEpochMs = input.port.now();
    while (input.port.now() < input.deadlineEpochMs) {
        if (!input.holdFullWindow && matching.copies.length >= input.count) {
            return { copies: matching.copies, stalled: false };
        }
        if (input.stallMs !== undefined && input.port.now() - progressEpochMs >= input.stallMs) {
            return { copies: matching.copies, stalled: true };
        }
        const remainingMs = input.deadlineEpochMs - input.port.now();
        await input.port.withAbort(
            input.port.sleep(Math.min(ALM_RECEIVED_POLL_INTERVAL_MS, remainingMs)),
            input.signal
        );
        const observed = resolveAlmMatchingCopies(input.context.state().events, input.match);
        progressEpochMs = observed.newestEventId === matching.newestEventId ? progressEpochMs : input.port.now();
        matching = observed;
    }
    return { copies: matching.copies, stalled: false };
}

function resolveAlmMatchingCopies(
    events: readonly RallarBlackBoxTestEvent[],
    match: AlmReceivedMessageMatch
): AlmMatchingCopies {
    const matching = events.flatMap((event) => {
        const data = toAlmMatchingCopy(event, match);
        return data === undefined ? [] : [{ eventId: event.eventId, data }];
    });
    return { copies: matching.map(({ data }) => data), newestEventId: matching.at(-1)?.eventId };
}

/** The inbound event's message `data` when it is a copy the count matches; `undefined` otherwise. */
function toAlmMatchingCopy(
    event: RallarBlackBoxTestEvent,
    match: AlmReceivedMessageMatch
): RallarBlackBoxTestRecord | undefined {
    if (
        !ALM_INBOUND_MESSAGE_TOPICS.includes(event.topic) ||
        (event.connection !== undefined && event.connection !== match.connection)
    ) {
        return undefined;
    }
    const data = decodeAlmRuntimeRecord(decodeAlmRuntimeRecord(event.payload).data);
    const matches = toAlmEventStringField(data, 'typeId') === match.typeId &&
        (match.msgId === undefined || toAlmEventStringField(data, 'msgId') === match.msgId);
    return matches ? data : undefined;
}

function toAlmEventStringField(record: RallarBlackBoxTestRecord, key: string): string {
    const value = record[key];
    return typeof value === 'string' ? value : '';
}
