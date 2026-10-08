import { Either } from '@shared/resilience/Either.ts';

import type {
    ControlDistributedRunArtifactBaseFileName,
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunArtifactFileName,
    ControlRunArtifactBundle,
    ControlRunArtifactFileName
} from '../control-snapshots.ts';
import {
    isFiniteNumber,
    isNonEmptyText,
    toFirstDecodeIssue
} from '../distributed-artifact-analysis/artifact-json-value-guards.ts';
import { isJsonRecordValue } from './json-schema-validation.ts';

interface ArtifactEnvelopeInput {
    readonly identityField: 'runId' | 'distributedRunId';
    readonly requiredFiles: readonly string[];
    readonly knownFiles: readonly string[];
}

const ORDINARY_FILES = Object.keys(
    {
        'report.json': true,
        'results.jsonl': true,
        'events.jsonl': true,
        'failures.json': true,
        'metadata.json': true
    } satisfies Record<ControlRunArtifactFileName, true>
);

const DISTRIBUTED_REQUIRED_FILES = Object.keys(
    {
        'distributed-run.json': true,
        'manifest.json': true,
        'control-run.json': true
    } satisfies Record<ControlDistributedRunArtifactBaseFileName, true>
);

const DISTRIBUTED_KNOWN_FILES = Object.keys(
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

/** The ordinary run carries all five files; individual readers own their contents. */
export function decodeControlRunArtifactBundle(value: unknown): Either<string, ControlRunArtifactBundle> {
    const issue = decodeArtifactEnvelopeIssue(value, {
        identityField: 'runId',
        requiredFiles: ORDINARY_FILES,
        knownFiles: ORDINARY_FILES
    });
    return issue === undefined ? Either.ofRight(value as ControlRunArtifactBundle) : Either.ofLeft(issue);
}

/** Distributed envelopes require three files; supplied known optional files must also be strings. */
export function decodeControlDistributedRunArtifactBundle(
    value: unknown
): Either<string, ControlDistributedRunArtifactBundle> {
    const issue = decodeArtifactEnvelopeIssue(value, {
        identityField: 'distributedRunId',
        requiredFiles: DISTRIBUTED_REQUIRED_FILES,
        knownFiles: DISTRIBUTED_KNOWN_FILES
    });
    return issue === undefined ? Either.ofRight(value as ControlDistributedRunArtifactBundle) : Either.ofLeft(issue);
}

function decodeArtifactEnvelopeIssue(value: unknown, input: ArtifactEnvelopeInput): string | undefined {
    const { identityField, requiredFiles, knownFiles } = input;
    if (!isJsonRecordValue(value)) {
        return 'artifact must be a JSON object';
    }
    const files = value.files;
    const issue = toFirstDecodeIssue([
        [isFiniteNumber(value.artifactSchemaVersion), 'artifactSchemaVersion must be a finite number'],
        [isNonEmptyText(value[identityField]), `${identityField} must be a non-empty string`],
        [isFiniteNumber(value.generatedAtEpochMs), 'generatedAtEpochMs must be a finite number'],
        [isJsonRecordValue(files), 'files must be a JSON object']
    ]);
    if (issue !== undefined || !isJsonRecordValue(files)) {
        return issue ?? 'files must be a JSON object';
    }
    const invalidFile = requiredFiles.find((file) => typeof files[file] !== 'string') ??
        knownFiles.find((file) => Object.hasOwn(files, file) && typeof files[file] !== 'string');
    return invalidFile === undefined ? undefined : `files.${invalidFile} must be a string`;
}
