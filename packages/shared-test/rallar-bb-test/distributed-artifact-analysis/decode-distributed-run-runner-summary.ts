import { Either } from '@shared/resilience/Either.ts';

import { RALLAR_BLACK_BOX_DISTRIBUTED_RUN_STATES, type RallarBlackBoxDistributedRunState } from '../distributed-run.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import { isNonEmptyText, isOneOf } from './artifact-json-value-guards.ts';

/** The run record the Hetzner runner writes to runner-summary.json once it stops driving a run. */
export interface DistributedRunRunnerSummary {
    readonly distributedRunId: string;
    readonly controlRunId: string;
    readonly state: RallarBlackBoxDistributedRunState;
    readonly ok: boolean;
    readonly artifactDir: string;
}

export function decodeDistributedRunRunnerSummary(value: unknown): Either<string, DistributedRunRunnerSummary> {
    if (!isJsonRecordValue(value)) {
        return Either.ofLeft('the runner summary must be a JSON object');
    }
    const { distributedRunId, controlRunId, state, ok, artifactDir } = value;
    if (!isNonEmptyText(distributedRunId)) {
        return Either.ofLeft('distributedRunId must be a non-empty string');
    }
    if (!isNonEmptyText(controlRunId)) {
        return Either.ofLeft('controlRunId must be a non-empty string');
    }
    if (!isOneOf(state, RALLAR_BLACK_BOX_DISTRIBUTED_RUN_STATES)) {
        return Either.ofLeft('state must be a distributed run state');
    }
    if (typeof ok !== 'boolean') {
        return Either.ofLeft('ok must be a boolean');
    }
    if (!isNonEmptyText(artifactDir)) {
        return Either.ofLeft('artifactDir must be a non-empty string');
    }
    return Either.ofRight({ distributedRunId, controlRunId, state, ok, artifactDir });
}
