import { Either } from '@shared/resilience/Either.ts';

import type {
    ControlDistributedRunArtifactBaseFileName,
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunArtifactFileName
} from '../control-snapshots.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import {
    isFiniteNumber,
    isNonEmptyText,
    toFirstDecodeIssue
} from './artifact-json-value-guards.ts';

const REQUIRED_FILES = Object.keys(
    {
        'distributed-run.json': true,
        'manifest.json': true,
        'control-run.json': true
    } satisfies Record<ControlDistributedRunArtifactBaseFileName, true>
);

const KNOWN_FILES = Object.keys(
    {
        'distributed-run.json': true,
        'manifest.json': true,
        'target-resolution.json': true,
        'control-run.json': true,
        'report.json': true,
        'results.jsonl': true,
        'events.jsonl': true,
        'failures.json': true,
        'metadata.json': true
    } satisfies Record<ControlDistributedRunArtifactFileName, true>
);

/** Validates the envelope; individual file readers own content and version-specific semantics. */
export function decodeControlDistributedRunArtifactBundle(
    value: unknown
): Either<string, ControlDistributedRunArtifactBundle> {
    if (!isJsonRecordValue(value)) {
        return Either.ofLeft('artifact must be a JSON object');
    }
    const files = value.files;
    const issue = toFirstDecodeIssue([
        [isFiniteNumber(value.artifactSchemaVersion), 'artifactSchemaVersion must be a finite number'],
        [isNonEmptyText(value.distributedRunId), 'distributedRunId must be a non-empty string'],
        [isFiniteNumber(value.generatedAtEpochMs), 'generatedAtEpochMs must be a finite number'],
        [isJsonRecordValue(files), 'files must be a JSON object']
    ]);
    if (issue !== undefined || !isJsonRecordValue(files)) {
        return Either.ofLeft(issue ?? 'files must be a JSON object');
    }
    const invalidFile = REQUIRED_FILES.find((file) => typeof files[file] !== 'string') ??
        KNOWN_FILES.find((file) => Object.hasOwn(files, file) && typeof files[file] !== 'string');
    return invalidFile === undefined
        ? Either.ofRight(value as ControlDistributedRunArtifactBundle)
        : Either.ofLeft(`files.${invalidFile} must be a string`);
}
