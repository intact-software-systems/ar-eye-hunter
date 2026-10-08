import { Either } from '@shared/resilience/Either.ts';

import type { ControlRunArtifactBundle, ControlRunArtifactFileName } from '../control-snapshots.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import {
    isFiniteNumber,
    isNonEmptyText,
    toFirstDecodeIssue
} from './artifact-json-value-guards.ts';

const REQUIRED_FILES = Object.keys(
    {
        'report.json': true,
        'results.jsonl': true,
        'events.jsonl': true,
        'failures.json': true,
        'metadata.json': true
    } satisfies Record<ControlRunArtifactFileName, true>
);

/** The ordinary run bundle carries all five files; their contents are decoded by their own artifact readers. */
export function decodeControlRunArtifactBundle(value: unknown): Either<string, ControlRunArtifactBundle> {
    if (!isJsonRecordValue(value)) {
        return Either.ofLeft('artifact must be a JSON object');
    }
    const files = value.files;
    const issue = toFirstDecodeIssue([
        [isFiniteNumber(value.artifactSchemaVersion), 'artifactSchemaVersion must be a finite number'],
        [isNonEmptyText(value.runId), 'runId must be a non-empty string'],
        [isFiniteNumber(value.generatedAtEpochMs), 'generatedAtEpochMs must be a finite number'],
        [isJsonRecordValue(files), 'files must be a JSON object']
    ]);
    if (issue !== undefined || !isJsonRecordValue(files)) {
        return Either.ofLeft(issue ?? 'files must be a JSON object');
    }
    const invalidFile = REQUIRED_FILES.find((file) => typeof files[file] !== 'string');
    return invalidFile === undefined
        ? Either.ofRight(value as ControlRunArtifactBundle)
        : Either.ofLeft(`files.${invalidFile} must be a string`);
}
