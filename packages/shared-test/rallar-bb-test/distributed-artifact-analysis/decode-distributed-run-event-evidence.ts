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
    let streamSummary: DistributedRunStreamSummary | undefined;
    let streamSummaryText: string | undefined;
    for (const candidate of [payloadData, payload?.payload, valueData, eventValue?.payload, payload, eventValue]) {
        streamSummary = decodeDistributedRunStreamSummary(candidate);
        if (streamSummary !== undefined) {
            streamSummaryText = JSON.stringify(candidate);
            break;
        }
    }
    return {
        agentId: decodeText(value.agentId),
        commandId: decodeText(value.commandId),
        transport: decodeText(value.transport),
        topic: decodeText(value.topic) ?? decodeText(payload?.topic) ?? decodeText(eventValue?.topic) ??
            decodeText(payloadData?.topic) ?? decodeText(valueData?.topic),
        severity: decodeText(eventValue?.severity) ?? decodeText(payload?.severity) ?? decodeText(value.severity),
        message: decodeText(eventValue?.message) ?? decodeText(payload?.message) ?? decodeText(value.message),
        streamSummary,
        streamSummaryText
    };
}
