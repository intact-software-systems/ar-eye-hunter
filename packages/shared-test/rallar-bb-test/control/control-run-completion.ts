import { Either } from '@shared/resilience/Either.ts';

import { isJsonRecordValue } from '../schema/json-schema-validation.ts';

/** The file in a run's artifact directory that holds a completed run's rows, beside its results and events JSONL. */
export const CONTROL_RUN_COMPLETION_FILE_NAME = 'control-run.json';

const CONTROL_RUN_COMPLETION_FILE_STATES = ['present', 'missing'] as const;
const CONTROL_RUN_COMPLETION_COUNT_KEYS = ['commands', 'results', 'events', 'stats', 'reports', 'heartbeats'] as const;

export type ControlRunCompletionFileState = typeof CONTROL_RUN_COMPLETION_FILE_STATES[number];

/** How many rows of each collection the completed run's file holds. */
export type ControlRunCompletionCounts = Readonly<Record<typeof CONTROL_RUN_COMPLETION_COUNT_KEYS[number], number>>;

export interface ControlRunCompletionFile {
    /** Relative to the control server's storage directory. */
    readonly path: string;
    readonly bytes: number;
    readonly writtenAtEpochMs: number;
    /** `missing` once a read or a restart found no file at the path; the index entry stays and reports it. */
    readonly state: ControlRunCompletionFileState;
}

/**
 * The index entry a control server keeps for a run whose rows left its live snapshot: the run's distributed runs
 * were all terminal and its agents all disconnected, so its rows were written once to its own file and the
 * snapshot keeps only this entry beside the agents and their counters. A completed run accepts no new envelopes.
 */
export interface ControlRunCompletion {
    readonly completedAtEpochMs: number;
    /** The run's retention revision the file was written from. */
    readonly retentionRevision: number;
    readonly counts: ControlRunCompletionCounts;
    readonly file: ControlRunCompletionFile;
}

export function decodeControlRunCompletion(value: unknown): Either<string, ControlRunCompletion> {
    if (!isJsonRecordValue(value)) {
        return Either.ofLeft('completion must be a JSON object');
    }
    const { completedAtEpochMs, retentionRevision, counts, file } = value;
    if (!isFiniteNumber(completedAtEpochMs)) {
        return Either.ofLeft('completion.completedAtEpochMs must be a finite number');
    }
    if (!isFiniteNumber(retentionRevision)) {
        return Either.ofLeft('completion.retentionRevision must be a finite number');
    }
    return decodeCounts(counts).flatMap(
        (issue) => Either.ofLeft(issue),
        (decodedCounts) =>
            decodeFile(file).mapRight((decodedFile) => ({
                completedAtEpochMs,
                retentionRevision,
                counts: decodedCounts,
                file: decodedFile
            }))
    );
}

function decodeCounts(value: unknown): Either<string, ControlRunCompletionCounts> {
    const counts = isJsonRecordValue(value) ? value : {};
    const invalid = CONTROL_RUN_COMPLETION_COUNT_KEYS.find((key) => !isFiniteNumber(counts[key]));
    if (invalid !== undefined) {
        return Either.ofLeft(`completion.counts.${invalid} must be a finite number`);
    }
    return Either.ofRight(Object.fromEntries(
        CONTROL_RUN_COMPLETION_COUNT_KEYS.map((key) => [key, counts[key] as number])
    ) as Record<typeof CONTROL_RUN_COMPLETION_COUNT_KEYS[number], number>);
}

function decodeFile(value: unknown): Either<string, ControlRunCompletionFile> {
    const file = isJsonRecordValue(value) ? value : {};
    const { path, bytes, writtenAtEpochMs, state } = file;
    if (typeof path !== 'string' || path.length === 0) {
        return Either.ofLeft('completion.file.path must be a non-empty string');
    }
    if (!isFiniteNumber(bytes)) {
        return Either.ofLeft('completion.file.bytes must be a finite number');
    }
    if (!isFiniteNumber(writtenAtEpochMs)) {
        return Either.ofLeft('completion.file.writtenAtEpochMs must be a finite number');
    }
    const fileState = CONTROL_RUN_COMPLETION_FILE_STATES.find((candidate) => candidate === state);
    if (fileState === undefined) {
        return Either.ofLeft(`completion.file.state must be ${CONTROL_RUN_COMPLETION_FILE_STATES.join(' or ')}`);
    }
    return Either.ofRight({ path, bytes, writtenAtEpochMs, state: fileState });
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}
