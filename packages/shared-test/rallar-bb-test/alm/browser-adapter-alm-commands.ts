import { BLACK_BOX_RALLAR_DELIVERY_ERROR_MESSAGE_PREFIXES } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/black-box-rallar-delivery-error-message-prefixes.ts';
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
    readonly signal: AbortSignal | undefined;
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
    invalidRuntimeResult: 'RALLAR_BLACK_BOX_ALM_INVALID_RUNTIME_RESULT',
    unknownDeliveryHandle: 'RALLAR_BLACK_BOX_ALM_UNKNOWN_DELIVERY_HANDLE',
    deliveryStateTimeout: 'RALLAR_BLACK_BOX_ALM_DELIVERY_STATE_TIMEOUT',
    scriptedPortsUnavailable: 'RALLAR_BLACK_BOX_ALM_SCRIPTED_PORTS_UNAVAILABLE',
    commandAborted: 'RALLAR_BLACK_BOX_ALM_COMMAND_ABORTED',
    messagesNotReceived: 'RALLAR_BLACK_BOX_ALM_MESSAGES_NOT_RECEIVED',
    messagesReceivedWhileAbsent: 'RALLAR_BLACK_BOX_ALM_MESSAGES_RECEIVED_WHILE_ABSENT'
} as const;

const ALM_MESSAGES_CARRIERS: readonly RallarBlackBoxTestMessagesCarrier[] = [
    'ws',
    'rtc',
    'rtc-with-ws-fallback'
];

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

/**
 * The control client intercepts `agent.reload` before it reaches this adapter, so reaching here
 * means the surface cannot reload: the request is recorded as a warning rather than a silent pass.
 */
function requestAlmAgentReload(
    input: AlmBrowserCommandInput<'agent.reload'>
): RallarBlackBoxTestCommandOutcome {
    const readyTimeoutMs = input.command.readyTimeoutMs;
    recordAlmDiagnostic({
        context: input.context,
        command: input.command,
        connection: undefined,
        topic: 'rallar.bb.agent.reload_requested',
        severity: 'warning',
        message: 'This runtime surface does not reload; the request was recorded only.',
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
    const abort = input.port.commandAbortScope(command, input.context);
    try {
        const observed = await observeAlmMessageCount({
            port: input.port,
            context: input.context,
            holdFullWindow: command.absent === true,
            count: command.count,
            match: { connection, typeId: command.typeId, msgId: command.msgId },
            deadlineEpochMs: waitDeadlineEpochMs(
                { timeoutMs: command.windowMs, deadlineEpochMs: command.deadlineEpochMs },
                input.port.now
            ),
            signal: abort.signal
        });
        return toAlmReceivedOutcome({ command, context: input.context, connection, observed });
    }
    catch (caught) {
        return toAlmFailureOutcome({
            context: input.context,
            command,
            connection,
            topic: 'rallar.bb.messages.received',
            error: toError(caught)
        });
    }
    finally {
        abort.cleanup();
    }
}

/**
 * Parity with the wait command: an absence claim holds the whole window and only then scans the
 * buffer, while a presence claim settles as soon as the recipe's count is on the log. Each poll
 * tick races the abort signal, so a recipe cancellation interrupts the hold instead of always
 * running the full window.
 */
async function observeAlmMessageCount(input: ObserveAlmMessageCountInput): Promise<number> {
    let observed = countAlmMatchingMessages(input.context.state().events, input.match);
    while (input.port.now() < input.deadlineEpochMs) {
        if (!input.holdFullWindow && observed >= input.count) {
            return observed;
        }
        const remainingMs = input.deadlineEpochMs - input.port.now();
        await input.port.withAbort(
            input.port.sleep(Math.min(ALM_RECEIVED_POLL_INTERVAL_MS, remainingMs)),
            input.signal
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
    return toAlmEventStringField(data, 'typeId') === match.typeId &&
        (match.msgId === undefined || toAlmEventStringField(data, 'msgId') === match.msgId);
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
    return error.name === ALM_ERROR_CODES.invalidRuntimeResult
        ? ALM_ERROR_CODES.invalidRuntimeResult
        : toAlmPageRuntimeErrorCode(error.message);
}

function toAlmPageRuntimeErrorCode(message: string): string {
    const prefixes = BLACK_BOX_RALLAR_DELIVERY_ERROR_MESSAGE_PREFIXES;
    if (message.startsWith(prefixes.unknownDeliveryHandle)) {
        return ALM_ERROR_CODES.unknownDeliveryHandle;
    }
    if (message.startsWith(prefixes.deliveryStateTimeout)) {
        return ALM_ERROR_CODES.deliveryStateTimeout;
    }
    return message.startsWith(prefixes.scriptedPortsUnavailable)
        ? ALM_ERROR_CODES.scriptedPortsUnavailable
        : ALM_ERROR_CODES.invalidCommandInput;
}

function decodeAlmMessagesSendResultValue(
    value: unknown
): RallarBlackBoxTestMessagesSendResultValue {
    const record = decodeAlmRuntimeRecord(value);
    const path = 'messages.send result';
    const msgId = readAlmOptionalStringField(record, path, 'msgId');
    const reason = readAlmOptionalStringField(record, path, 'reason');
    return {
        handleId: requireAlmStringField(record, path, 'handleId'),
        ...(msgId === undefined ? {} : { msgId }),
        carrier: requireAlmCarrierField(record, path),
        status: requireAlmStringField(record, path, 'status'),
        ...(reason === undefined ? {} : { reason })
    };
}

function decodeAlmDeliveryResultValue(
    value: unknown
): RallarBlackBoxTestMessagesObserveResultValue {
    const record = decodeAlmRuntimeRecord(value);
    const path = 'delivery observation';
    return {
        handleId: requireAlmStringField(record, path, 'handleId'),
        state: requireAlmStringField(record, path, 'state'),
        submitted: requireAlmBooleanField(record, path, 'submitted'),
        confirmedPeerIds: requireAlmStringListField(record, path, 'confirmedPeerIds'),
        unconfirmedPeerIds: requireAlmStringListField(record, path, 'unconfirmedPeerIds'),
        attempts: requireAlmNumberField(record, path, 'attempts')
    };
}

function decodeAlmStorageCountersResultValue(
    value: unknown
): RallarBlackBoxTestStorageCountersResultValue {
    const record = decodeAlmRuntimeRecord(value);
    const path = 'storage.counters result';
    const byOwner = requireAlmRecordField(record, path, 'byOwner');
    return {
        total: requireAlmNumberField(record, path, 'total'),
        byOwner: {
            'al-admission': requireAlmNumberField(byOwner, `${path}.byOwner`, 'al-admission'),
            'al-work': requireAlmNumberField(byOwner, `${path}.byOwner`, 'al-work')
        },
        byKind: requireAlmCountsByKind(requireAlmRecordField(record, path, 'byKind'), `${path}.byKind`)
    };
}

function decodeAlmRuntimeRecord(value: unknown): RallarBlackBoxTestRecord {
    return typeof value === 'object' && value !== null
        ? value as RallarBlackBoxTestRecord
        : {};
}

function requireAlmCountsByKind(
    record: RallarBlackBoxTestRecord,
    path: string
): Readonly<Record<string, number>> {
    return Object.fromEntries(
        Object.keys(record).map((key) => [key, requireAlmNumberField(record, path, key)])
    );
}

function requireAlmCarrierField(
    record: RallarBlackBoxTestRecord,
    path: string
): RallarBlackBoxTestMessagesCarrier {
    const carrier = ALM_MESSAGES_CARRIERS.find((candidate) => candidate === record.carrier);
    if (carrier === undefined) {
        throw toAlmInvalidRuntimeResultError(`${path}.carrier`);
    }
    return carrier;
}

function requireAlmStringField(
    record: RallarBlackBoxTestRecord,
    path: string,
    key: string
): string {
    const value = record[key];
    if (typeof value !== 'string') {
        throw toAlmInvalidRuntimeResultError(`${path}.${key}`);
    }
    return value;
}

function readAlmOptionalStringField(
    record: RallarBlackBoxTestRecord,
    path: string,
    key: string
): string | undefined {
    const value = record[key];
    if (value === undefined || typeof value === 'string') {
        return value;
    }
    throw toAlmInvalidRuntimeResultError(`${path}.${key}`);
}

function requireAlmNumberField(
    record: RallarBlackBoxTestRecord,
    path: string,
    key: string
): number {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw toAlmInvalidRuntimeResultError(`${path}.${key}`);
    }
    return value;
}

function requireAlmBooleanField(
    record: RallarBlackBoxTestRecord,
    path: string,
    key: string
): boolean {
    const value = record[key];
    if (typeof value !== 'boolean') {
        throw toAlmInvalidRuntimeResultError(`${path}.${key}`);
    }
    return value;
}

function requireAlmStringListField(
    record: RallarBlackBoxTestRecord,
    path: string,
    key: string
): readonly string[] {
    const value = record[key];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        throw toAlmInvalidRuntimeResultError(`${path}.${key}`);
    }
    return value as readonly string[];
}

function requireAlmRecordField(
    record: RallarBlackBoxTestRecord,
    path: string,
    key: string
): RallarBlackBoxTestRecord {
    const value = record[key];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw toAlmInvalidRuntimeResultError(`${path}.${key}`);
    }
    return value as RallarBlackBoxTestRecord;
}

function toAlmInvalidRuntimeResultError(field: string): Error {
    const error = new Error(`The page runtime returned no usable ${field}.`);
    error.name = ALM_ERROR_CODES.invalidRuntimeResult;
    return error;
}

function toAlmEventStringField(record: RallarBlackBoxTestRecord, key: string): string {
    const value = record[key];
    return typeof value === 'string' ? value : '';
}
