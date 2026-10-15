import { Either } from '@shared/resilience/Either.ts';

import { isJsonRecordValue } from '../schema/json-schema-validation.ts';

export const CONTROL_ARTIFACT_OVERFLOW_ROW_KIND = 'control-artifact-overflow';
export const CONTROL_ARTIFACT_OVERFLOW_AGENT_ID = 'control-server';
export const CONTROL_ARTIFACT_OVERFLOW_TOPIC = 'rallar.bb.control.artifact-overflow';

/**
 * The control server writes this row at the same place in a run's results.jsonl and events.jsonl when its artifact
 * recorder dropped that run's oldest pending rows. In events.jsonl it decodes as a diagnostic event of the control
 * server; in results.jsonl it stands in for no result.
 */
export interface ControlArtifactOverflowRow {
    readonly kind: typeof CONTROL_ARTIFACT_OVERFLOW_ROW_KIND;
    readonly status: 'diagnostic';
    readonly agentId: typeof CONTROL_ARTIFACT_OVERFLOW_AGENT_ID;
    readonly atEpochMs: number;
    readonly value: ControlArtifactOverflowValue;
}

export interface ControlArtifactOverflowCounts {
    /** Dropped results; each one also loses its step-result row in events.jsonl. */
    readonly omittedResults: number;
    /** Dropped events.jsonl rows, step-result rows included. */
    readonly omittedEventRows: number;
    readonly omittedBytes: number;
    readonly maxPendingBytes: number;
}

export interface ControlArtifactOverflowValue extends ControlArtifactOverflowCounts {
    readonly topic: typeof CONTROL_ARTIFACT_OVERFLOW_TOPIC;
    readonly severity: 'warning';
}

export function toControlArtifactOverflowRow(
    counts: ControlArtifactOverflowCounts,
    atEpochMs: number
): ControlArtifactOverflowRow {
    return {
        kind: CONTROL_ARTIFACT_OVERFLOW_ROW_KIND,
        status: 'diagnostic',
        agentId: CONTROL_ARTIFACT_OVERFLOW_AGENT_ID,
        atEpochMs,
        value: { topic: CONTROL_ARTIFACT_OVERFLOW_TOPIC, severity: 'warning', ...counts }
    };
}

export function decodeControlArtifactOverflowRow(value: unknown): Either<string, ControlArtifactOverflowRow> {
    if (!isJsonRecordValue(value) || value.kind !== CONTROL_ARTIFACT_OVERFLOW_ROW_KIND) {
        return Either.ofLeft(`kind must be ${CONTROL_ARTIFACT_OVERFLOW_ROW_KIND}`);
    }
    const counts = isJsonRecordValue(value.value) ? value.value : {};
    const omittedResults = decodeCount(counts.omittedResults);
    const omittedEventRows = decodeCount(counts.omittedEventRows);
    const omittedBytes = decodeCount(counts.omittedBytes);
    const maxPendingBytes = decodeCount(counts.maxPendingBytes);
    if (
        value.status !== 'diagnostic' || value.agentId !== CONTROL_ARTIFACT_OVERFLOW_AGENT_ID ||
        typeof value.atEpochMs !== 'number' || counts.topic !== CONTROL_ARTIFACT_OVERFLOW_TOPIC ||
        omittedResults === undefined || omittedEventRows === undefined || omittedBytes === undefined ||
        maxPendingBytes === undefined
    ) {
        return Either.ofLeft('an overflow row names the control server, its time and its omitted counts');
    }
    return Either.ofRight(
        toControlArtifactOverflowRow(
            { omittedResults, omittedEventRows, omittedBytes, maxPendingBytes },
            value.atEpochMs
        )
    );
}

function decodeCount(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}
