import { decodeAlmReceivedMessageIdentity } from '../../../alm/decode-alm-runtime-result.ts';
import type { AlmReceivedMessageIdentity } from '../../../alm/rallar-black-box-alm-result-values.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestMessagesReceivedCommand,
    RallarBlackBoxTestMessagesSendCommand
} from '../../../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../../../schema/json-schema-validation.ts';
import type { AlmConformanceScenarioId } from '../alm-conformance-scenario-definition.ts';
import type { RecordedAlmConformanceParticipant } from './assess-alm-conformance-identity.ts';
import { toRecordedAlmResultValue } from './to-recorded-alm-result-value.ts';

/** A send's marker is its scenario id, so a renamed fallback scenario fails to compile here. */
const ALM_FALLBACK_MARKERS = [
    'fallback-within-deadline',
    'receipt-exhausted-fallback',
    'unicast-fallback'
] as const satisfies readonly AlmConformanceScenarioId[];

export type AlmFallbackMarker = (typeof ALM_FALLBACK_MARKERS)[number];

export interface AlmReceivedTraceIdentityInput {
    readonly send: RallarBlackBoxTestMessagesSendCommand;
    readonly msgId: string;
    readonly traceId: string;
    readonly receiver: RecordedAlmConformanceParticipant;
}

/**
 * Joins the receiver's counted copies to the send by `msgId`, never by trace: a superseded settlement carries the
 * replacement's trace. A fallback cell must deliver a copy; any other send may legitimately never arrive.
 */
export function assessAlmReceivedTraceIdentity(input: AlmReceivedTraceIdentityInput): readonly string[] {
    const { send, msgId, traceId, receiver } = input;
    const counts = receiver.participant.recipe.commands.filter((command) => isJoinedCount(command, input));
    const listed = counts.map((count) => toReceivedCopies(receiver, count));
    if (listed.some((copies) => copies === undefined)) {
        return [`${send.commandId}: a receiver count lists malformed received copies.`];
    }
    const copies = listed.flatMap((entries) => entries ?? []).filter((copy) => copy.msgId === msgId);
    const arrivals = toArrivalTransports(send);
    return [
        ...(copies.some((copy) => copy.traceId !== traceId)
            ? [`${send.commandId}: a received copy carries another trace.`]
            : []),
        ...(copies.some((copy) => !arrivals.includes(copy.transport))
            ? [`${send.commandId}: a received copy arrived on another transport.`]
            : []),
        ...(copies.length === 0 && isAlmFallbackMarker(toSendMarker(send))
            ? [`${send.commandId}: no received copy joins the fallback send.`]
            : [])
    ];
}

/**
 * A fallback cell, and the held reload original (D56), may hand the message to WS inside its deadline, so either leg
 * may deliver it. Every other identity send arrives on its first carrier.
 */
export function toArrivalTransports(send: RallarBlackBoxTestMessagesSendCommand): readonly ('rtc' | 'ws')[] {
    if (send.carrier === 'ws') {
        return ['ws'];
    }
    const marker = toSendMarker(send);
    const handedOver = marker === 'delivery-reload' || isAlmFallbackMarker(marker);
    return send.carrier === 'rtc-with-ws-fallback' && handedOver ? ['rtc', 'ws'] : ['rtc'];
}

export function isAlmFallbackMarker(value: unknown): value is AlmFallbackMarker {
    return typeof value === 'string' && ALM_FALLBACK_MARKERS.some((marker) => marker === value);
}

function isJoinedCount(
    command: RallarBlackBoxTestCommand,
    { send, msgId }: AlmReceivedTraceIdentityInput
): command is RallarBlackBoxTestMessagesReceivedCommand {
    return command.kind === 'messages.received' && command.absent !== true && command.typeId === send.typeId &&
        (command.msgId === undefined || command.msgId === msgId);
}

/** The lane's own decoder reads the recorded copies, so a copy outside its contract makes the count malformed. */
function toReceivedCopies(
    receiver: RecordedAlmConformanceParticipant,
    count: RallarBlackBoxTestMessagesReceivedCommand
): readonly AlmReceivedMessageIdentity[] | undefined {
    const value = toRecordedAlmResultValue(receiver, count);
    const received = isJsonRecordValue(value) && Array.isArray(value.received) ? value.received : undefined;
    const copies = received?.map((entry) => decodeAlmReceivedMessageIdentity(entry).foldRight((copy) => copy));
    return copies?.every((copy) => copy !== undefined) ? copies : undefined;
}

function toSendMarker(send: RallarBlackBoxTestMessagesSendCommand): string | undefined {
    const marker = isJsonRecordValue(send.payload) ? send.payload.marker : undefined;
    return typeof marker === 'string' ? marker : undefined;
}
