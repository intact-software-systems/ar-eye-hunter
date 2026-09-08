import { toError } from '@shared/resilience/to-error.ts';
import type { RallarBlackBoxBrowserRallarRuntime } from '../browser-adapter.ts';
import { normalizeRallarBlackBoxRuntimeDiagnostic } from '../diagnostics.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandContext,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestMessagesCarrier,
    RallarBlackBoxTestMessagesObserveResultValue,
    RallarBlackBoxTestMessagesSendResultValue,
    RallarBlackBoxTestRecord,
    RallarBlackBoxTestSeverity,
    RallarBlackBoxTestStorageCountersResultValue
} from '../types.ts';
import { waitDeadlineEpochMs } from '../wait/wait-for-event.ts';
import type { RallarBlackBoxTestAlmCommandKind } from './control-protocol-alm-commands.ts';

export type RallarBlackBoxAlmCommandWithId =
    & Extract<RallarBlackBoxTestCommand, Readonly<{ kind: RallarBlackBoxTestAlmCommandKind; }>>
    & Readonly<{ commandId: string; }>;

export interface RallarBlackBoxAlmAbortScope {
    readonly signal?: AbortSignal;
    cleanup(): void;
}

/** Everything the ALM handlers borrow from the browser adapter, bound by the adapter itself. */
export interface RallarBlackBoxAlmBrowserPort {
    readonly requireRuntime: () => RallarBlackBoxBrowserRallarRuntime;
    readonly commandAbortScope: (
        command: RallarBlackBoxAlmCommandWithId,
        context: RallarBlackBoxTestCommandContext
    ) => RallarBlackBoxAlmAbortScope;
    readonly withAbort: <T>(operation: Promise<T>, signal: AbortSignal | undefined) => Promise<T>;
    readonly resolveCommandFields: (
        command: RallarBlackBoxAlmCommandWithId,
        context: RallarBlackBoxTestCommandContext
    ) => RallarBlackBoxTestRecord;
    readonly resolveConnection: (
        command: RallarBlackBoxAlmCommandWithId,
        context: RallarBlackBoxTestCommandContext
    ) => string;
    readonly sleep: (ms: number) => Promise<void>;
    readonly now: () => number;
}

interface AlmBrowserCommandInput<K extends RallarBlackBoxTestAlmCommandKind> {
    readonly port: RallarBlackBoxAlmBrowserPort;
    readonly command: Extract<RallarBlackBoxAlmCommandWithId, Readonly<{ kind: K; }>>;
    readonly context: RallarBlackBoxTestCommandContext;
}

interface RunAlmRuntimeCommandInput<T> {
    readonly port: RallarBlackBoxAlmBrowserPort;
    readonly command: RallarBlackBoxAlmCommandWithId;
    readonly context: RallarBlackBoxTestCommandContext;
    readonly connection: string | undefined;
    readonly topic: string;
    readonly invoke: (runtime: RallarBlackBoxBrowserRallarRuntime) => Promise<T>;
}

interface RecordAlmDiagnosticInput<T> {
    readonly context: RallarBlackBoxTestCommandContext;
    readonly command: RallarBlackBoxAlmCommandWithId;
    readonly connection: string | undefined;
    readonly topic: string;
    readonly severity: RallarBlackBoxTestSeverity;
    readonly message: string | undefined;
    readonly value: T;
}

interface AlmFailureOutcomeInput {
    readonly context: RallarBlackBoxTestCommandContext;
    readonly command: RallarBlackBoxAlmCommandWithId;
    readonly connection: string | undefined;
    readonly topic: string;
    readonly error: Error;
}

interface AlmReceivedMessageMatch {
    readonly connection: string;
    readonly typeId: string;
    readonly msgId: string | undefined;
}

interface ObserveAlmMessageCountInput {
    readonly port: RallarBlackBoxAlmBrowserPort;
    readonly context: RallarBlackBoxTestCommandContext;
    readonly holdFullWindow: boolean;
    readonly count: number;
    readonly match: AlmReceivedMessageMatch;
    readonly deadlineEpochMs: number;
}

interface AlmReceivedOutcomeInput {
    readonly command: Extract<RallarBlackBoxAlmCommandWithId, Readonly<{ kind: 'messages.received'; }>>;
    readonly context: RallarBlackBoxTestCommandContext;
    readonly connection: string;
    readonly observed: number;
}

type AlmDeliveryKind = 'messages.observe' | 'messages.cancel' | 'messages.receipts';

const ALM_DELIVERY_TOPICS: Readonly<Record<AlmDeliveryKind, string>> = {
    'messages.observe': 'rallar.bb.messages.observed',
    'messages.cancel': 'rallar.bb.messages.cancelled',
    'messages.receipts': 'rallar.bb.messages.receipts'
};

const ALM_ERROR_CODES = {
    invalidCommandInput: 'RALLAR_BLACK_BOX_ALM_INVALID_COMMAND_INPUT',
    unknownDeliveryHandle: 'RALLAR_BLACK_BOX_ALM_UNKNOWN_DELIVERY_HANDLE',
    deliveryStateTimeout: 'RALLAR_BLACK_BOX_ALM_DELIVERY_STATE_TIMEOUT',
    commandAborted: 'RALLAR_BLACK_BOX_ALM_COMMAND_ABORTED',
    messagesNotReceived: 'RALLAR_BLACK_BOX_ALM_MESSAGES_NOT_RECEIVED',
    messagesReceivedWhileAbsent: 'RALLAR_BLACK_BOX_ALM_MESSAGES_RECEIVED_WHILE_ABSENT'
} as const;

// The adapter's own abort fires a hair before the page's observe deadline, so the cancelled and
// timed-out command must not be reported as a rejected recipe input.
const ALM_ABORTED_ERROR_NAMES: readonly string[] = [
    'RALLAR_BLACK_BOX_ABORTED',
    'RALLAR_BLACK_BOX_TIMEOUT'
];

const ALM_INBOUND_MESSAGE_TOPICS: readonly string[] = [
    'rallar.browser.ws.message',
    'rallar.browser.messages.rtc.message'
];

const ALM_RECEIVED_POLL_INTERVAL_MS = 10;
const ALM_DIAGNOSTIC_SOURCE = 'browser-adapter';

export async function executeAlmBrowserCommand(
    port: RallarBlackBoxAlmBrowserPort,
    command: RallarBlackBoxAlmCommandWithId,
    context: RallarBlackBoxTestCommandContext
): Promise<RallarBlackBoxTestCommandOutcome> {
    switch (command.kind) {
        case 'messages.send':
            return await sendAlmMessage({ port, command, context });
        case 'messages.observe':
        case 'messages.cancel':
        case 'messages.receipts':
            return await readAlmDelivery({ port, command, context });
        case 'messages.received':
            return await countAlmReceivedMessages({ port, command, context });
        case 'fault.inject':
            return await injectAlmFault({ port, command, context });
        case 'storage.counters':
            return await readAlmStorageCounters({ port, command, context });
        case 'agent.reload':
            return requestAlmAgentReload({ port, command, context });
    }
}

function sendAlmMessage(
    input: AlmBrowserCommandInput<'messages.send'>
): Promise<RallarBlackBoxTestCommandOutcome> {
    const connection = input.port.resolveConnection(input.command, input.context);
    const send = {
        ...input.port.resolveCommandFields(input.command, input.context),
        connection,
        handleId: input.command.handleId ?? input.command.commandId
    };
    return runAlmRuntimeCommand({
        port: input.port,
        command: input.command,
        context: input.context,
        connection,
        topic: 'rallar.bb.messages.sent',
        invoke: async (runtime) => decodeAlmMessagesSendResultValue(await runtime.sendMessage(send))
    });
}

function readAlmDelivery(
    input: AlmBrowserCommandInput<AlmDeliveryKind>
): Promise<RallarBlackBoxTestCommandOutcome> {
    const kind = input.command.kind;
    const connection = input.port.resolveConnection(input.command, input.context);
    const handle = {
        ...input.port.resolveCommandFields(input.command, input.context),
        connection,
        handleId: input.command.handleId,
        ...(kind === 'messages.observe'
            ? { timeoutMs: toAlmObserveTimeoutMs(input.command, input.port.now) }
            : {})
    };
    return runAlmRuntimeCommand({
        port: input.port,
        command: input.command,
        context: input.context,
        connection,
        topic: ALM_DELIVERY_TOPICS[kind],
        invoke: (runtime) => readAlmDeliveryObservation(runtime, kind, handle)
    });
}

async function readAlmDeliveryObservation(
    runtime: RallarBlackBoxBrowserRallarRuntime,
    kind: AlmDeliveryKind,
    handle: RallarBlackBoxTestRecord
): Promise<RallarBlackBoxTestMessagesObserveResultValue> {
    switch (kind) {
        case 'messages.cancel':
            return decodeAlmDeliveryResultValue(await runtime.cancelDelivery(handle));
        case 'messages.receipts':
            return decodeAlmDeliveryResultValue(await runtime.readReceipts(handle));
        default:
            return decodeAlmDeliveryResultValue(await runtime.observeDelivery(handle));
    }
}

function injectAlmFault(
    input: AlmBrowserCommandInput<'fault.inject'>
): Promise<RallarBlackBoxTestCommandOutcome> {
    const fault = input.port.resolveCommandFields(input.command, input.context);
    const faultId = input.command.faultId;
    return runAlmRuntimeCommand({
        port: input.port,
        command: input.command,
        context: input.context,
        connection: undefined,
        topic: 'rallar.bb.fault.injected',
        invoke: async (runtime) => {
            await runtime.injectFault(fault);
            return { faultId, injected: true };
        }
    });
}

function readAlmStorageCounters(
    input: AlmBrowserCommandInput<'storage.counters'>
): Promise<RallarBlackBoxTestCommandOutcome> {
    const counters = input.port.resolveCommandFields(input.command, input.context);
    return runAlmRuntimeCommand({
        port: input.port,
        command: input.command,
        context: input.context,
        connection: undefined,
        topic: 'rallar.bb.storage.counters',
        invoke: async (runtime) => decodeAlmStorageCountersResultValue(await runtime.readStorageCounters(counters))
    });
}

/** Task 11 performs the reload in the control agent; the adapter only records the request. */
function requestAlmAgentReload(
    input: AlmBrowserCommandInput<'agent.reload'>
): RallarBlackBoxTestCommandOutcome {
    const readyTimeoutMs = input.command.readyTimeoutMs;
    recordAlmDiagnostic({
        context: input.context,
        command: input.command,
        connection: undefined,
        topic: 'rallar.bb.agent.reload_requested',
        severity: 'info',
        message: undefined,
        value: { readyTimeoutMs }
    });
    return {
        status: 'ok',
        value: { requested: true, readyTimeoutMs },
        nextStatus: input.context.state().status
    };
}

async function runAlmRuntimeCommand<T>(
    input: RunAlmRuntimeCommandInput<T>
): Promise<RallarBlackBoxTestCommandOutcome> {
    const abort = input.port.commandAbortScope(input.command, input.context);
    try {
        const value = await input.port.withAbort(
            input.invoke(input.port.requireRuntime()),
            abort.signal
        );
        recordAlmDiagnostic({
            context: input.context,
            command: input.command,
            connection: input.connection,
            topic: input.topic,
            severity: 'info',
            message: undefined,
            value
        });
        return { status: 'ok', value, nextStatus: input.context.state().status };
    }
    catch (caught) {
        return toAlmFailureOutcome({
            context: input.context,
            command: input.command,
            connection: input.connection,
            topic: input.topic,
            error: toError(caught)
        });
    }
    finally {
        abort.cleanup();
    }
}

async function countAlmReceivedMessages(
    input: AlmBrowserCommandInput<'messages.received'>
): Promise<RallarBlackBoxTestCommandOutcome> {
    const command = input.command;
    const connection = input.port.resolveConnection(command, input.context);
    const observed = await observeAlmMessageCount({
        port: input.port,
        context: input.context,
        holdFullWindow: command.absent === true,
        count: command.count,
        match: { connection, typeId: command.typeId, msgId: command.msgId },
        deadlineEpochMs: waitDeadlineEpochMs(
            { timeoutMs: command.windowMs, deadlineEpochMs: command.deadlineEpochMs },
            input.port.now
        )
    });
    return toAlmReceivedOutcome({ command, context: input.context, connection, observed });
}

/**
 * Parity with the wait command: an absence claim holds the whole window and only then scans the
 * buffer, while a presence claim settles as soon as the recipe's count is on the log.
 */
async function observeAlmMessageCount(input: ObserveAlmMessageCountInput): Promise<number> {
    let observed = countAlmMatchingMessages(input.context.state().events, input.match);
    while (input.port.now() < input.deadlineEpochMs) {
        if (!input.holdFullWindow && observed >= input.count) {
            return observed;
        }
        await input.port.sleep(
            Math.min(ALM_RECEIVED_POLL_INTERVAL_MS, input.deadlineEpochMs - input.port.now())
        );
        observed = countAlmMatchingMessages(input.context.state().events, input.match);
    }
    return observed;
}

function countAlmMatchingMessages(
    events: readonly RallarBlackBoxTestEvent[],
    match: AlmReceivedMessageMatch
): number {
    return events.filter((event) => isAlmInboundMessageEvent(event, match)).length;
}

function isAlmInboundMessageEvent(
    event: RallarBlackBoxTestEvent,
    match: AlmReceivedMessageMatch
): boolean {
    if (!ALM_INBOUND_MESSAGE_TOPICS.includes(event.topic)) {
        return false;
    }
    if (event.connection !== undefined && event.connection !== match.connection) {
        return false;
    }
    const data = decodeAlmRuntimeRecord(decodeAlmRuntimeRecord(event.payload).data);
    return toAlmStringField(data, 'typeId') === match.typeId &&
        (match.msgId === undefined || toAlmStringField(data, 'msgId') === match.msgId);
}

function toAlmReceivedOutcome(input: AlmReceivedOutcomeInput): RallarBlackBoxTestCommandOutcome {
    const command = input.command;
    const absent = command.absent === true;
    const passed = absent
        ? input.observed < Math.max(command.count, 1)
        : input.observed >= command.count;
    const value = {
        typeId: command.typeId,
        ...(command.msgId === undefined ? {} : { msgId: command.msgId }),
        count: command.count,
        observed: input.observed,
        absent
    };
    recordAlmDiagnostic({
        context: input.context,
        command,
        connection: input.connection,
        topic: 'rallar.bb.messages.received',
        severity: passed ? 'info' : 'error',
        message: undefined,
        value
    });
    return passed
        ? { status: 'ok', value, nextStatus: input.context.state().status }
        : {
            status: 'failed',
            value,
            error: {
                code: absent
                    ? ALM_ERROR_CODES.messagesReceivedWhileAbsent
                    : ALM_ERROR_CODES.messagesNotReceived,
                message: `messages.received observed ${input.observed} ${command.typeId} ` +
                    `messages against count ${command.count}.`,
                details: value
            },
            nextStatus: 'failed'
        };
}

function toAlmObserveTimeoutMs(
    command: RallarBlackBoxAlmCommandWithId,
    now: () => number
): number {
    return Math.max(0, waitDeadlineEpochMs(command, now) - now());
}

function recordAlmDiagnostic<T>(input: RecordAlmDiagnosticInput<T>): void {
    input.context.recordEvent({
        kind: 'diagnostic',
        topic: input.topic,
        commandId: input.command.commandId,
        connection: input.connection,
        severity: input.severity,
        payload: normalizeRallarBlackBoxRuntimeDiagnostic({
            topic: input.topic,
            severity: input.severity,
            commandId: input.command.commandId,
            connection: input.connection,
            message: input.message,
            data: input.value,
            payload: input.value,
            source: ALM_DIAGNOSTIC_SOURCE
        })
    });
}

function toAlmFailureOutcome(input: AlmFailureOutcomeInput): RallarBlackBoxTestCommandOutcome {
    const code = toAlmErrorCode(input.error);
    const value = { kind: input.command.kind, code, message: input.error.message };
    recordAlmDiagnostic({
        context: input.context,
        command: input.command,
        connection: input.connection,
        topic: input.topic,
        severity: 'error',
        message: input.error.message,
        value
    });
    return {
        status: 'failed',
        value,
        error: { code, message: input.error.message, details: value },
        nextStatus: 'failed'
    };
}

function toAlmErrorCode(error: Error): string {
    if (ALM_ABORTED_ERROR_NAMES.includes(error.name)) {
        return ALM_ERROR_CODES.commandAborted;
    }
    if (error.message.startsWith('Unknown delivery handle')) {
        return ALM_ERROR_CODES.unknownDeliveryHandle;
    }
    return error.message.includes('did not reach')
        ? ALM_ERROR_CODES.deliveryStateTimeout
        : ALM_ERROR_CODES.invalidCommandInput;
}

function decodeAlmMessagesSendResultValue(
    value: unknown
): RallarBlackBoxTestMessagesSendResultValue {
    const record = decodeAlmRuntimeRecord(value);
    const reason = toAlmStringField(record, 'reason');
    return {
        handleId: toAlmStringField(record, 'handleId'),
        msgId: toAlmStringField(record, 'msgId'),
        carrier: toAlmCarrierField(record),
        status: toAlmStringField(record, 'status'),
        ...(reason.length > 0 ? { reason } : {})
    };
}

function decodeAlmDeliveryResultValue(
    value: unknown
): RallarBlackBoxTestMessagesObserveResultValue {
    const record = decodeAlmRuntimeRecord(value);
    return {
        handleId: toAlmStringField(record, 'handleId'),
        state: toAlmStringField(record, 'state'),
        submitted: record.submitted === true,
        confirmedPeerIds: toAlmStringListField(record, 'confirmedPeerIds'),
        unconfirmedPeerIds: toAlmStringListField(record, 'unconfirmedPeerIds'),
        attempts: toAlmNumberField(record, 'attempts')
    };
}

function decodeAlmStorageCountersResultValue(
    value: unknown
): RallarBlackBoxTestStorageCountersResultValue {
    const record = decodeAlmRuntimeRecord(value);
    const byOwner = decodeAlmRuntimeRecord(record.byOwner);
    const byKind = decodeAlmRuntimeRecord(record.byKind);
    return {
        total: toAlmNumberField(record, 'total'),
        byOwner: {
            'al-admission': toAlmNumberField(byOwner, 'al-admission'),
            'al-work': toAlmNumberField(byOwner, 'al-work')
        },
        byKind: toAlmCountsByKind(byKind)
    };
}

function decodeAlmRuntimeRecord(value: unknown): RallarBlackBoxTestRecord {
    return typeof value === 'object' && value !== null
        ? value as RallarBlackBoxTestRecord
        : {};
}

function toAlmCountsByKind(record: RallarBlackBoxTestRecord): Readonly<Record<string, number>> {
    return Object.fromEntries(
        Object.keys(record).map((key) => [key, toAlmNumberField(record, key)])
    );
}

function toAlmCarrierField(record: RallarBlackBoxTestRecord): RallarBlackBoxTestMessagesCarrier {
    const carrier = record.carrier;
    return carrier === 'rtc' || carrier === 'rtc-with-ws-fallback' ? carrier : 'ws';
}

function toAlmStringField(record: RallarBlackBoxTestRecord, key: string): string {
    const value = record[key];
    return typeof value === 'string' ? value : '';
}

function toAlmNumberField(record: RallarBlackBoxTestRecord, key: string): number {
    const value = record[key];
    return typeof value === 'number' ? value : 0;
}

function toAlmStringListField(
    record: RallarBlackBoxTestRecord,
    key: string
): readonly string[] {
    const value = record[key];
    return Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string')
        : [];
}
