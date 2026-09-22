import type { ControlResultEnvelope } from '../control-protocol.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import {
    decodeBoolean,
    decodeElapsedMs,
    decodeNumber,
    decodeRecordItems,
    decodeText
} from './decode-artifact-json-values.ts';
import {
    decodeNestedStreamSummary,
    type DistributedRunStreamSummary
} from './decode-distributed-run-stream-summary.ts';
import { decodeReceiverDeliverySpec, type ReceiverDeliverySpec } from './decode-receiver-delivery-spec.ts';

/** Receiver stats a result reports. */
export interface DistributedRunStatsSummary {
    /** Absent when the stats name no command. */
    readonly commandId?: string;
    readonly receivedMessages: number;
    /** Absent when the stats metadata sets no receiver delivery bound. */
    readonly receiverDeliverySpec?: ReceiverDeliverySpec;
}

/**
 * What analysis reads from a control result envelope or a results.jsonl row. Control snapshots and the
 * artifact recorder shape results differently, so most fields are optional.
 */
export interface DistributedRunResultEvidence {
    /** Absent when the row names no agent. */
    readonly agentId?: string;
    /** The command id, or the command part of an `agentId:commandId` result key; absent when neither names one. */
    readonly commandId?: string;
    /** The first of resultKey, id, commandId and envelope.commandId that names this execution; absent when none does. */
    readonly executionIdentity?: string;
    /** Absent when the row records no status text; control envelopes never do. */
    readonly status?: string;
    /** Absent when the row records no boolean outcome. */
    readonly ok?: boolean;
    /** Absent when the row names no transport; control envelopes never do. */
    readonly transport?: string;
    /** Absent when the row names no command action; control envelopes never do. */
    readonly action?: string;
    /** Absent when the row carries no top-level message; control envelopes never do. */
    readonly message?: string;
    /** The code of the recorded actual value or error; absent when neither records one. */
    readonly failureCode?: string;
    /** The message of the recorded actual value or error; absent when neither records one. */
    readonly failureMessage?: string;
    /** Codes and messages of the actual value, its details, the error and the value, in that order. */
    readonly streamFailureTexts: readonly string[];
    /** Source, message and code of the actual value, error or value, then its details' source and message. */
    readonly deliveryFailureTexts: readonly string[];
    /** Absent when no result payload wrapper holds an rtc.stream summary. */
    readonly streamSummary?: DistributedRunStreamSummary;
    /** Absent when no result payload wrapper reports a receiver message count. */
    readonly stats?: DistributedRunStatsSummary;
    /** The command id the result payload names; absent when the payload names none. */
    readonly payloadCommandId?: string;
    /** The first receiver delivery bound set on the row, its payload, its value or its stats; absent when none is set. */
    readonly receiverDeliverySpec?: ReceiverDeliverySpec;
    /** Absent when the row records neither a duration nor both start and end times. */
    readonly durationMs?: number;
    /** Results of the recipes a recipe.run command ran. */
    readonly nestedResults: readonly DistributedRunResultEvidence[];
}

/** Absent when the row is not a JSON object. */
export function decodeDistributedRunResultEvidence(value: unknown): DistributedRunResultEvidence | undefined {
    if (!isJsonRecordValue(value)) {
        return undefined;
    }
    const payload = isJsonRecordValue(value.result) ? value.result : undefined;
    const resultValue = isJsonRecordValue(value.value) ? value.value : undefined;
    const commandId = decodeResultCommandId(value.commandId, value.resultKey);
    const stats = decodeStatsSummary(value.result) ?? decodeStatsSummary(value.value) ??
        decodeStatsSummary(value.actual) ?? decodeStatsSummary(value.error);
    const failure = value.actual ?? value.error;
    return {
        agentId: decodeText(value.agentId),
        commandId,
        executionIdentity: decodeText(value.resultKey) ?? decodeText(value.id) ?? decodeText(value.commandId) ??
            (isJsonRecordValue(value.envelope) ? decodeText(value.envelope.commandId) : undefined) ?? commandId,
        status: decodeText(value.status),
        ok: decodeBoolean(value.ok),
        transport: decodeText(value.transport),
        action: decodeText(value.action),
        message: decodeText(value.message),
        failureCode: isJsonRecordValue(failure) ? decodeText(failure.code) : undefined,
        failureMessage: isJsonRecordValue(failure) ? decodeText(failure.message) : undefined,
        streamFailureTexts: decodeStreamFailureTexts(value),
        deliveryFailureTexts: decodeDeliveryFailureTexts(value.actual ?? value.error ?? value.value),
        streamSummary: decodeNestedStreamSummary(value.result) ?? decodeNestedStreamSummary(value.value) ??
            decodeNestedStreamSummary(value.actual) ?? decodeNestedStreamSummary(value.error),
        stats,
        payloadCommandId: decodeText(payload?.commandId),
        receiverDeliverySpec: decodeReceiverDeliverySpec(value.metadata) ??
            decodeReceiverDeliverySpec(payload?.metadata) ??
            decodeReceiverDeliverySpec(resultValue?.metadata) ?? stats?.receiverDeliverySpec,
        durationMs: decodeResultDurationMs(value),
        nestedResults: decodeNestedResults(value)
    };
}

/**
 * The control protocol decoder checks a result envelope's identity and outcome only, so its result and
 * error payloads are read here as recorded.
 */
export function toControlResultEvidence(envelope: ControlResultEnvelope): DistributedRunResultEvidence {
    const { result: payload, error } = envelope;
    const payloadRecord = isJsonRecordValue(payload) ? payload : undefined;
    const errorRecord = isJsonRecordValue(error) ? error : undefined;
    const stats = decodeStatsSummary(payload) ?? decodeStatsSummary(error);
    return {
        agentId: envelope.agentId,
        commandId: envelope.commandId,
        executionIdentity: envelope.commandId,
        ok: envelope.ok,
        failureCode: decodeText(errorRecord?.code),
        failureMessage: decodeText(errorRecord?.message),
        streamFailureTexts: [errorRecord?.code, errorRecord?.message].flatMap((text) => decodeText(text) ?? []),
        deliveryFailureTexts: decodeDeliveryFailureTexts(error),
        streamSummary: decodeNestedStreamSummary(payload) ?? decodeNestedStreamSummary(error),
        stats,
        payloadCommandId: decodeText(payloadRecord?.commandId),
        receiverDeliverySpec: decodeReceiverDeliverySpec(payloadRecord?.metadata) ?? stats?.receiverDeliverySpec,
        durationMs: decodeNumber(payloadRecord?.durationMs) ??
            decodeElapsedMs(payloadRecord?.startedAtEpochMs, payloadRecord?.endedAtEpochMs),
        nestedResults: decodePayloadNestedResults(payload)
    };
}

/** The command id, or the command part of the `agentId:commandId` result key the recorder writes; absent when neither names one. */
export function decodeResultCommandId(commandId: unknown, resultKey: unknown): string | undefined {
    const decodedCommandId = decodeText(commandId);
    const decodedResultKey = decodeText(resultKey);
    if (decodedCommandId !== undefined || decodedResultKey === undefined) {
        return decodedCommandId;
    }
    const [, keyedCommandId] = decodedResultKey.split(/:(.*)/s);
    return keyedCommandId || decodedResultKey;
}

/** Stats carry a finite counters.messages, directly or under value, result or actual. */
function decodeStatsSummary(value: unknown): DistributedRunStatsSummary | undefined {
    if (!isJsonRecordValue(value)) {
        return undefined;
    }
    for (const candidate of [value, value.value, value.result, value.actual]) {
        if (isJsonRecordValue(candidate) && isJsonRecordValue(candidate.counters)) {
            const receivedMessages = decodeNumber(candidate.counters.messages);
            if (receivedMessages !== undefined) {
                return {
                    commandId: decodeText(candidate.commandId),
                    receivedMessages,
                    receiverDeliverySpec: decodeReceiverDeliverySpec(candidate.metadata)
                };
            }
        }
    }
    return undefined;
}

function decodeStreamFailureTexts(value: unknown): readonly string[] {
    if (!isJsonRecordValue(value)) {
        return [];
    }
    const actual = isJsonRecordValue(value.actual) ? value.actual : undefined;
    const actualDetails = isJsonRecordValue(actual?.details) ? actual.details : undefined;
    const error = isJsonRecordValue(value.error) ? value.error : undefined;
    const resultValue = isJsonRecordValue(value.value) ? value.value : undefined;
    return [
        actual?.code,
        actual?.message,
        actualDetails?.code,
        actualDetails?.message,
        error?.code,
        error?.message,
        resultValue?.code,
        resultValue?.message
    ].flatMap((text) => decodeText(text) ?? []);
}

function decodeDeliveryFailureTexts(value: unknown): readonly string[] {
    if (!isJsonRecordValue(value)) {
        return [];
    }
    const details = isJsonRecordValue(value.details) ? value.details : undefined;
    return [value.source, value.message, value.code, details?.source, details?.message]
        .flatMap((text) => decodeText(text) ?? []);
}

function decodeResultDurationMs(value: unknown): number | undefined {
    if (!isJsonRecordValue(value)) {
        return undefined;
    }
    const payload = isJsonRecordValue(value.result) ? value.result : undefined;
    return decodeNumber(payload?.durationMs) ??
        decodeNumber(value.durationMs) ??
        decodeElapsedMs(payload?.startedAtEpochMs, payload?.endedAtEpochMs) ??
        decodeElapsedMs(value.startedAtEpochMs, value.endedAtEpochMs);
}

function decodeNestedResults(value: unknown): readonly DistributedRunResultEvidence[] {
    if (!isJsonRecordValue(value)) {
        return [];
    }
    const actual = isJsonRecordValue(value.actual) ? value.actual : undefined;
    const resultValue = isJsonRecordValue(value.value) ? value.value : undefined;
    return [
        ...decodeRecordItems(actual?.results, decodeDistributedRunResultEvidence),
        ...decodePayloadNestedResults(value.result),
        ...decodeRecordItems(resultValue?.results, decodeDistributedRunResultEvidence)
    ];
}

function decodePayloadNestedResults(value: unknown): readonly DistributedRunResultEvidence[] {
    if (!isJsonRecordValue(value)) {
        return [];
    }
    const payloadValue = isJsonRecordValue(value.value) ? value.value : undefined;
    return [value.results, payloadValue?.results]
        .flatMap((results) => decodeRecordItems(results, decodeDistributedRunResultEvidence));
}
