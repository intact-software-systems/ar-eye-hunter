import type { ControlEventEnvelope } from '../control-protocol.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import { decodeText } from './decode-artifact-json-values.ts';
import {
    decodeDistributedRunStreamSummary,
    type DistributedRunStreamSummary
} from './decode-distributed-run-stream-summary.ts';

/**
 * What analysis reads from a control event envelope or an events.jsonl row. Control snapshots carry the
 * event under payload and the recorder under value, so every field is absent when the row does not record it.
 */
export interface DistributedRunEventEvidence {
    readonly agentId?: string;
    readonly commandId?: string;
    readonly transport?: string;
    /** The first topic on the row, its payload or value, or their data. */
    readonly topic?: string;
    /** The first severity on the value, the payload or the row. */
    readonly severity?: string;
    /** The first message on the value, the payload or the row. */
    readonly message?: string;
    readonly streamSummary?: DistributedRunStreamSummary;
    /** The recorded stream summary as JSON text; absent with the summary. */
    readonly streamSummaryText?: string;
}

export function decodeDistributedRunEventEvidence(value: unknown): DistributedRunEventEvidence {
    if (!isJsonRecordValue(value)) {
        return {};
    }
    const payload = isJsonRecordValue(value.payload) ? value.payload : undefined;
    const eventValue = isJsonRecordValue(value.value) ? value.value : undefined;
    const payloadData = isJsonRecordValue(payload?.data) ? payload.data : undefined;
    const valueData = isJsonRecordValue(eventValue?.data) ? eventValue.data : undefined;
    return {
        agentId: decodeText(value.agentId),
        commandId: decodeText(value.commandId),
        transport: decodeText(value.transport),
        topic: decodeText(value.topic) ?? decodeText(payload?.topic) ?? decodeText(eventValue?.topic) ??
            decodeText(payloadData?.topic) ?? decodeText(valueData?.topic),
        severity: decodeText(eventValue?.severity) ?? decodeText(payload?.severity) ?? decodeText(value.severity),
        message: decodeText(eventValue?.message) ?? decodeText(payload?.message) ?? decodeText(value.message),
        ...decodeFirstStreamSummary([
            payloadData,
            payload?.payload,
            valueData,
            eventValue?.payload,
            payload,
            eventValue
        ])
    };
}

/** The control protocol decoder checks an event envelope's identity only, so its payload is read here as recorded. */
export function toControlEventEvidence(envelope: ControlEventEnvelope): DistributedRunEventEvidence {
    const payload = isJsonRecordValue(envelope.payload) ? envelope.payload : undefined;
    const payloadData = isJsonRecordValue(payload?.data) ? payload.data : undefined;
    return {
        agentId: envelope.agentId,
        commandId: envelope.commandId,
        topic: decodeText(payload?.topic) ?? decodeText(payloadData?.topic),
        severity: decodeText(payload?.severity),
        message: decodeText(payload?.message),
        ...decodeFirstStreamSummary([payloadData, payload?.payload, payload])
    };
}

type EventStreamSummaryEvidence = Pick<DistributedRunEventEvidence, 'streamSummary' | 'streamSummaryText'>;

function decodeFirstStreamSummary(candidates: readonly unknown[]): EventStreamSummaryEvidence {
    for (const candidate of candidates) {
        const streamSummary = decodeDistributedRunStreamSummary(candidate);
        if (streamSummary !== undefined) {
            return { streamSummary, streamSummaryText: JSON.stringify(candidate) };
        }
    }
    return {};
}
