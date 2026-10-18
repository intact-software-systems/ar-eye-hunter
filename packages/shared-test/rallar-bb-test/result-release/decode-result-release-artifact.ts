import type { ApiJsonObject } from '@shared/api/api-json-value.ts';
import { Either } from '@shared/resilience/Either.ts';

import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import type { ResultReleaseOutcome } from './result-release-protocol.ts';

export interface ResultReleaseArtifactOwner {
    readonly runId: string;
    readonly agentIds: ReadonlySet<string>;
}

export interface ResultReleaseArtifact {
    readonly agentId: string;
    readonly outcome: ResultReleaseOutcome;
}

/** Recorder journals mix step results, sequenced runtime events and sequence-free control acknowledgements. */
export function decodeResultReleaseArtifact(
    row: ApiJsonObject,
    owner: ResultReleaseArtifactOwner
): Either<string, ResultReleaseArtifact | null> {
    const value = row.value;
    if (!isJsonRecordValue(value) || value.topic !== 'rallar.bb.results.release') {
        return Either.ofRight(null);
    }
    if (
        row.kind !== 'rtc-diagnostic' || row.status !== 'diagnostic' ||
        (row.runId !== undefined && row.runId !== owner.runId) ||
        typeof row.agentId !== 'string' || row.agentId.length === 0 || !owner.agentIds.has(row.agentId) ||
        typeof row.atEpochMs !== 'number' || !Number.isFinite(row.atEpochMs) ||
        typeof value.requestId !== 'string' || value.requestId.length === 0 ||
        (value.status !== 'released' && value.status !== 'deferred' && value.status !== 'rejected') ||
        !Number.isSafeInteger(value.releasedResults) || Number(value.releasedResults) < 0 ||
        typeof value.reason !== 'string' || value.history !== undefined || value.eventId !== undefined
    ) {
        return Either.ofLeft('Release acknowledgement has a malformed or foreign diagnostic record.');
    }
    return Either.ofRight({
        agentId: row.agentId,
        outcome: {
            requestId: value.requestId,
            status: value.status,
            releasedResults: value.releasedResults as number,
            reason: value.reason
        }
    });
}
