import { Either } from '@shared/resilience/Either.ts';

import type { ControlRunSnapshot } from '../control-snapshots.ts';
import type {
    DistributedRunArtifactParseWarning,
    DistributedRunArtifactRejection,
    DistributedRunSnapshots,
    DistributedRunTargetResolutionAnalysis
} from '../distributed-artifact-analysis.ts';
import {
    distributedArtifactPipelineFile,
    distributedArtifactPipelineJsonlRows,
    type ParsedDistributedArtifactPipeline
} from '../distributed-artifact-pipeline.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import { decodeText } from './decode-artifact-json-values.ts';
import { decodeControlDistributedRunSnapshot } from './decode-control-distributed-run-snapshot.ts';
import { decodeControlPostRequest, type DistributedRunControlPostRequest } from './decode-control-post-request.ts';
import { decodeControlRunSnapshot } from './decode-control-run-snapshot.ts';
import {
    decodeDistributedRunEventEvidence,
    type DistributedRunEventEvidence
} from './decode-distributed-run-event-evidence.ts';
import {
    decodeBundledFailure,
    decodeDistributedRunFleetReportEvidence,
    decodeTargetResolutionAnalysis,
    type DistributedRunBundledFailure,
    type DistributedRunFleetReportEvidence
} from './decode-distributed-run-report-evidence.ts';
import {
    decodeDistributedRunResultEvidence,
    type DistributedRunResultEvidence
} from './decode-distributed-run-result-evidence.ts';
import {
    decodeDistributedRunRunnerSummary,
    type DistributedRunRunnerSummary
} from './decode-distributed-run-runner-summary.ts';
import { decodeJsonlControlEventEnvelope, decodeJsonlControlResultEnvelope } from './decode-jsonl-control-envelopes.ts';

export interface ControlPostFailureArtifact {
    readonly request: DistributedRunControlPostRequest;
    /** Absent when the failed request returned no response body or the body file is missing. */
    readonly response?: ControlPostFailureResponse;
}

export interface ControlPostFailureResponse {
    readonly fileName: string;
    readonly text: string;
    /** Absent when the body is not a JSON object with any field. */
    readonly message?: string;
}

export interface DistributedRunBundleContent {
    readonly variant: 'distributed-run';
    readonly parseWarnings: readonly DistributedRunArtifactParseWarning[];
    readonly snapshots: DistributedRunSnapshots;
    readonly fleetReport: DistributedRunFleetReportEvidence;
    /** Absent when failures.json lists no failures. */
    readonly bundledFailure?: DistributedRunBundledFailure;
    /** Absent when target-resolution.json records nothing. */
    readonly targetResolution?: DistributedRunTargetResolutionAnalysis;
    /** Absent when the runner recorded no failed control request. */
    readonly controlPostFailure?: ControlPostFailureArtifact;
    readonly results: readonly DistributedRunResultEvidence[];
    readonly events: readonly DistributedRunEventEvidence[];
}

export interface DistributedRunControlRequestFailureContent {
    readonly variant: 'control-request-failure';
    readonly parseWarnings: readonly DistributedRunArtifactParseWarning[];
    readonly controlPostFailure: ControlPostFailureArtifact;
    /** Absent when the runner stopped before it wrote runner-summary.json. */
    readonly runnerSummary?: DistributedRunRunnerSummary;
}

export type DistributedRunArtifactContent =
    | DistributedRunBundleContent
    | DistributedRunControlRequestFailureContent;

const CONTROL_POST_ERROR_METADATA_FILE_NAME = 'control-post-error-metadata.json';

/**
 * A folder without distributed-run.json is analyzable only when the runner recorded the failed
 * control request that prevented the run from existing.
 */
export function toDistributedRunArtifactContent(
    parsed: ParsedDistributedArtifactPipeline
): Either<DistributedRunArtifactRejection, DistributedRunArtifactContent> {
    const parseWarnings: DistributedRunArtifactParseWarning[] = [];
    return toRecordedControlPostFailure({ parsed, warnings: parseWarnings }).flatMap(
        (rejection) => Either.ofLeft(rejection),
        ({ controlPostFailure }): Either<DistributedRunArtifactRejection, DistributedRunArtifactContent> => {
            if (distributedArtifactPipelineFile(parsed, 'distributed-run.json').status !== 'missing') {
                return toBundleContent({ parsed, warnings: parseWarnings }, controlPostFailure);
            }
            return controlPostFailure === undefined
                ? Either.ofLeft({
                    fileName: 'distributed-run.json',
                    message:
                        'distributed-run.json is required: the artifacts hold neither a distributed run snapshot nor a failed control request record.'
                })
                : toControlRequestFailureContent(parsed, controlPostFailure, parseWarnings);
        }
    );
}

export function toDistributedRunBundleContent(
    parsed: ParsedDistributedArtifactPipeline
): Either<DistributedRunArtifactRejection, DistributedRunBundleContent> {
    return toDistributedRunArtifactContent(parsed).flatMap(
        (rejection) => Either.ofLeft(rejection),
        (content) =>
            content.variant === 'distributed-run'
                ? Either.ofRight(content)
                : Either.ofLeft({
                    fileName: 'distributed-run.json',
                    message:
                        `distributed-run.json is required: the artifacts record a failed control ${content.controlPostFailure.request.phase} request instead of a distributed run.`
                })
    );
}

interface RecordedControlPostFailure {
    /** Absent when the runner recorded no failed control request. */
    readonly controlPostFailure?: ControlPostFailureArtifact;
}

/** The parsed artifact files and the warnings their optional files add while they are read. */
interface ArtifactFileReading {
    readonly parsed: ParsedDistributedArtifactPipeline;
    readonly warnings: DistributedRunArtifactParseWarning[];
}

function toBundleContent(
    reading: ArtifactFileReading,
    controlPostFailure: ControlPostFailureArtifact | undefined
): Either<DistributedRunArtifactRejection, DistributedRunArtifactContent> {
    return toSnapshots(reading.parsed).mapRight((snapshots) => {
        const fleetReport = toOptionalJsonFileEvidence(
            reading,
            'fleet-report.json',
            decodeDistributedRunFleetReportEvidence
        );
        const bundledFailure = toOptionalJsonFileEvidence(reading, 'failures.json', decodeBundledFailure);
        const targetResolution = toOptionalJsonFileEvidence(
            reading,
            'target-resolution.json',
            decodeTargetResolutionAnalysis
        );
        return {
            variant: 'distributed-run',
            parseWarnings: reading.warnings,
            snapshots: {
                distributedRun: snapshots.distributedRun,
                controlRun: toControlRunWithJsonlEnvelopes(reading.parsed, snapshots.controlRun)
            },
            fleetReport,
            ...(bundledFailure === undefined ? {} : { bundledFailure }),
            ...(targetResolution === undefined ? {} : { targetResolution }),
            ...(controlPostFailure === undefined ? {} : { controlPostFailure }),
            results: toJsonlEvidence(reading, 'results.jsonl', decodeDistributedRunResultEvidence),
            events: toJsonlEvidence(reading, 'events.jsonl', decodeDistributedRunEventEvidence)
        };
    });
}

/**
 * An artifact import whose control-run.json holds no results or events carries that evidence in the
 * recorder JSONL files; rows that name their agent, command and outcome stand in for the envelopes.
 */
function toControlRunWithJsonlEnvelopes(
    parsed: ParsedDistributedArtifactPipeline,
    controlRun: ControlRunSnapshot
): ControlRunSnapshot {
    const toRowValues = (fileName: string) =>
        distributedArtifactPipelineJsonlRows(parsed, fileName).flatMap((row) =>
            row.status === 'parsed' ? [row.value] : []
        );
    return {
        ...controlRun,
        results: controlRun.results.length > 0
            ? controlRun.results
            : toRowValues('results.jsonl').flatMap((row) =>
                decodeJsonlControlResultEnvelope(row, controlRun.runId) ?? []
            ),
        events: controlRun.events.length > 0
            ? controlRun.events
            : toRowValues('events.jsonl').flatMap((row) => decodeJsonlControlEventEnvelope(row, controlRun.runId) ?? [])
    };
}

function toSnapshots(
    parsed: ParsedDistributedArtifactPipeline
): Either<DistributedRunArtifactRejection, DistributedRunSnapshots> {
    return toRequiredJsonFileValue(
        parsed,
        { fileName: 'distributed-run.json', contractName: 'a distributed run snapshot' },
        decodeControlDistributedRunSnapshot
    ).flatMap(
        (rejection) => Either.ofLeft(rejection),
        (distributedRun) =>
            toRequiredJsonFileValue(
                parsed,
                { fileName: 'control-run.json', contractName: 'a control run snapshot' },
                decodeControlRunSnapshot
            ).mapRight((controlRun) => ({ distributedRun, controlRun }))
    );
}

function toControlRequestFailureContent(
    parsed: ParsedDistributedArtifactPipeline,
    controlPostFailure: ControlPostFailureArtifact,
    parseWarnings: readonly DistributedRunArtifactParseWarning[]
): Either<DistributedRunArtifactRejection, DistributedRunArtifactContent> {
    const content = {
        variant: 'control-request-failure' as const,
        parseWarnings,
        controlPostFailure
    };
    if (distributedArtifactPipelineFile(parsed, 'runner-summary.json').status === 'missing') {
        return Either.ofRight(content);
    }
    return toRequiredJsonFileValue(
        parsed,
        { fileName: 'runner-summary.json', contractName: 'a runner summary' },
        decodeDistributedRunRunnerSummary
    ).mapRight((runnerSummary) => ({ ...content, runnerSummary }));
}

function toRecordedControlPostFailure(
    reading: ArtifactFileReading
): Either<DistributedRunArtifactRejection, RecordedControlPostFailure> {
    if (distributedArtifactPipelineFile(reading.parsed, CONTROL_POST_ERROR_METADATA_FILE_NAME).status === 'missing') {
        return Either.ofRight({});
    }
    return toRequiredJsonFileValue(
        reading.parsed,
        { fileName: CONTROL_POST_ERROR_METADATA_FILE_NAME, contractName: 'a control request record' },
        decodeControlPostRequest
    ).mapRight((request) => ({ controlPostFailure: toControlPostFailure(reading, request) }));
}

function toControlPostFailure(
    reading: ArtifactFileReading,
    request: DistributedRunControlPostRequest
): ControlPostFailureArtifact {
    const responseFile = request.responseFile;
    if (responseFile === undefined) {
        return { request };
    }
    const text = reading.parsed.projectedFiles[responseFile];
    if (text === undefined) {
        reading.warnings.push({
            fileName: responseFile,
            message:
                `${responseFile} is named by ${CONTROL_POST_ERROR_METADATA_FILE_NAME} but is not among the artifact files.`
        });
        return { request };
    }
    const message = toOptionalJsonFileEvidence(reading, responseFile, decodeControlResponseMessage);
    return { request, response: { fileName: responseFile, text, ...(message === undefined ? {} : { message }) } };
}

interface RequiredJsonFile {
    readonly fileName: string;
    readonly contractName: string;
}

function toRequiredJsonFileValue<Decoded>(
    parsed: ParsedDistributedArtifactPipeline,
    required: RequiredJsonFile,
    decodeFile: (value: unknown) => Either<string, Decoded>
): Either<DistributedRunArtifactRejection, Decoded> {
    const { fileName, contractName } = required;
    const file = distributedArtifactPipelineFile(parsed, fileName);
    if (file.status === 'missing' || file.status === 'empty') {
        return Either.ofLeft({ fileName, message: `${fileName} is required and must not be empty.` });
    }
    if (file.format !== 'json' || file.status !== 'parsed') {
        return Either.ofLeft({
            fileName,
            message: `${fileName} is not valid JSON: ${toJsonErrorDetail(fileName, file.message)}`
        });
    }
    return decodeFile(file.value).mapLeft((issue) => ({
        fileName,
        message: `${fileName} is not ${contractName}: ${issue.endsWith('.') ? issue : `${issue}.`}`
    }));
}

/** A missing, empty or malformed optional file reads as an empty JSON object; malformed ones add a warning. */
function toOptionalJsonFileEvidence<Evidence>(
    reading: ArtifactFileReading,
    fileName: string,
    decodeFile: (value: unknown) => Evidence
): Evidence {
    const file = distributedArtifactPipelineFile(reading.parsed, fileName);
    if (file.format === 'json' && file.status === 'parsed') {
        return decodeFile(file.value);
    }
    if (file.status !== 'missing' && file.status !== 'empty') {
        reading.warnings.push({
            fileName,
            message: `${fileName} is not valid JSON: ${toJsonErrorDetail(fileName, file.message)}`
        });
    }
    return decodeFile({});
}

function toJsonlEvidence<Evidence>(
    reading: ArtifactFileReading,
    fileName: string,
    decodeRow: (value: unknown) => Evidence
): readonly Evidence[] {
    return distributedArtifactPipelineJsonlRows(reading.parsed, fileName).flatMap((row) => {
        if (row.status === 'parsed') {
            return [decodeRow(row.value)];
        }
        reading.warnings.push({
            fileName,
            lineNumber: row.lineNumber,
            message: row.message ?? `${fileName}:${row.lineNumber} is not valid JSON.`
        });
        return [];
    });
}

function decodeControlResponseMessage(value: unknown): string | undefined {
    if (!isJsonRecordValue(value) || Object.keys(value).length === 0) {
        return undefined;
    }
    const error = isJsonRecordValue(value.error) ? value.error : undefined;
    return decodeText(value.message) ?? decodeText(error?.message) ?? decodeText(value.error) ??
        decodeText(value.detail) ?? decodeText(value.title) ?? 'Control API request failed.';
}

function toJsonErrorDetail(fileName: string, message: string | undefined): string {
    const prefix = `${fileName} is not valid JSON: `;
    return message?.startsWith(prefix)
        ? message.slice(prefix.length)
        : message ?? 'Unknown JSON parse error';
}
