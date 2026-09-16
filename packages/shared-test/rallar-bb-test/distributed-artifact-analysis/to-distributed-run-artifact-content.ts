import { Either } from '@shared/resilience/Either.ts';

import type { ControlRunSnapshot } from '../control-snapshots.ts';
import type {
    DistributedRunArtifactParseWarning,
    DistributedRunArtifactRejection,
    DistributedRunSnapshots
} from '../distributed-artifact-analysis.ts';
import {
    distributedArtifactPipelineFile,
    distributedArtifactPipelineJsonlRows,
    type ParsedDistributedArtifactPipeline
} from '../distributed-artifact-pipeline.ts';
import type { RallarBlackBoxDistributedTargetResolution } from '../distributed-run.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import { decodeText } from './decode-artifact-json-values.ts';
import {
    decodeControlDistributedRunSnapshot,
    decodeTargetResolution
} from './decode-control-distributed-run-snapshot.ts';
import { decodeControlPostRequest, type DistributedRunControlPostRequest } from './decode-control-post-request.ts';
import { decodeControlRunSnapshot } from './decode-control-run-snapshot.ts';
import {
    decodeDistributedRunEventEvidence,
    type DistributedRunEventEvidence
} from './decode-distributed-run-event-evidence.ts';
import {
    decodeBundledFailure,
    decodeDistributedRunFleetReportEvidence,
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
    /** Absent when fleet-report.json is missing, empty, not valid JSON or not a JSON object. */
    readonly fleetReport?: DistributedRunFleetReportEvidence;
    /** Absent when failures.json lists no failures. */
    readonly bundledFailure?: DistributedRunBundledFailure;
    /** Absent when target-resolution.json is missing, records null, or is not a target resolution; a warning says which. */
    readonly targetResolution?: RallarBlackBoxDistributedTargetResolution;
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

interface RecordedTargetResolution {
    /** Absent when target-resolution.json records null. */
    readonly targetResolution?: RallarBlackBoxDistributedTargetResolution;
}

/** A value read from the artifact files together with the warnings reading it raised. */
interface ArtifactFileReading<Value> {
    readonly value: Value;
    readonly warnings: readonly DistributedRunArtifactParseWarning[];
}

/**
 * A folder without distributed-run.json is analyzable only when the runner recorded the failed
 * control request that prevented the run from existing.
 */
export function toDistributedRunArtifactContent(
    parsed: ParsedDistributedArtifactPipeline
): Either<DistributedRunArtifactRejection, DistributedRunArtifactContent> {
    return toRecordedControlPostFailure(parsed).flatMap(
        (rejection) => Either.ofLeft(rejection),
        (recorded): Either<DistributedRunArtifactRejection, DistributedRunArtifactContent> => {
            if (distributedArtifactPipelineFile(parsed, 'distributed-run.json').status !== 'missing') {
                return toBundleContent(parsed, recorded);
            }
            const controlPostFailure = recorded.value;
            return controlPostFailure === undefined
                ? Either.ofLeft({
                    fileName: 'distributed-run.json',
                    message:
                        'distributed-run.json is required: the artifacts hold neither a distributed run snapshot nor a failed control request record.'
                })
                : toControlRequestFailureContent(parsed, { value: controlPostFailure, warnings: recorded.warnings });
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

function toBundleContent(
    parsed: ParsedDistributedArtifactPipeline,
    recorded: ArtifactFileReading<ControlPostFailureArtifact | undefined>
): Either<DistributedRunArtifactRejection, DistributedRunArtifactContent> {
    return toSnapshots(parsed).mapRight((snapshots) => {
        const fleetReport = toOptionalJsonFileEvidence(
            parsed,
            'fleet-report.json',
            decodeDistributedRunFleetReportEvidence
        );
        const bundledFailure = toOptionalJsonFileEvidence(parsed, 'failures.json', decodeBundledFailure);
        const targetResolution = toOptionalJsonFileValue(
            parsed,
            { fileName: 'target-resolution.json', contractName: 'a target resolution' },
            decodeRecordedTargetResolution
        );
        const results = toJsonlEvidence(parsed, 'results.jsonl', decodeDistributedRunResultEvidence);
        const events = toJsonlEvidence(parsed, 'events.jsonl', decodeDistributedRunEventEvidence);
        return {
            variant: 'distributed-run',
            parseWarnings: [recorded, fleetReport, bundledFailure, targetResolution, results, events]
                .flatMap((reading) => reading.warnings),
            snapshots: {
                distributedRun: snapshots.distributedRun,
                controlRun: toControlRunWithJsonlEnvelopes(parsed, snapshots.controlRun)
            },
            ...(fleetReport.value === undefined ? {} : { fleetReport: fleetReport.value }),
            ...(bundledFailure.value === undefined ? {} : { bundledFailure: bundledFailure.value }),
            ...targetResolution.value,
            ...(recorded.value === undefined ? {} : { controlPostFailure: recorded.value }),
            results: results.value,
            events: events.value
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
    recorded: ArtifactFileReading<ControlPostFailureArtifact>
): Either<DistributedRunArtifactRejection, DistributedRunArtifactContent> {
    const content = {
        variant: 'control-request-failure' as const,
        parseWarnings: recorded.warnings,
        controlPostFailure: recorded.value
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
    parsed: ParsedDistributedArtifactPipeline
): Either<DistributedRunArtifactRejection, ArtifactFileReading<ControlPostFailureArtifact | undefined>> {
    if (distributedArtifactPipelineFile(parsed, CONTROL_POST_ERROR_METADATA_FILE_NAME).status === 'missing') {
        return Either.ofRight({ value: undefined, warnings: [] });
    }
    return toRequiredJsonFileValue(
        parsed,
        { fileName: CONTROL_POST_ERROR_METADATA_FILE_NAME, contractName: 'a control request record' },
        decodeControlPostRequest
    ).mapRight((request) => toControlPostFailure(parsed, request));
}

function toControlPostFailure(
    parsed: ParsedDistributedArtifactPipeline,
    request: DistributedRunControlPostRequest
): ArtifactFileReading<ControlPostFailureArtifact> {
    const responseFile = request.responseFile;
    if (responseFile === undefined) {
        return { value: { request }, warnings: [] };
    }
    const text = parsed.projectedFiles[responseFile];
    if (text === undefined) {
        return {
            value: { request },
            warnings: [{
                fileName: responseFile,
                message:
                    `${responseFile} is named by ${CONTROL_POST_ERROR_METADATA_FILE_NAME} but is not among the artifact files.`
            }]
        };
    }
    const message = toOptionalJsonFileEvidence(parsed, responseFile, decodeControlResponseMessage);
    return {
        value: {
            request,
            response: {
                fileName: responseFile,
                text,
                ...(message.value === undefined ? {} : { message: message.value })
            }
        },
        warnings: message.warnings
    };
}

interface ContractJsonFile {
    readonly fileName: string;
    readonly contractName: string;
}

function toRequiredJsonFileValue<Decoded>(
    parsed: ParsedDistributedArtifactPipeline,
    contractFile: ContractJsonFile,
    decodeFile: (value: unknown) => Either<string, Decoded>
): Either<DistributedRunArtifactRejection, Decoded> {
    const { fileName, contractName } = contractFile;
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

/** A missing or empty optional file is absent; one that is not valid JSON or not the contract is absent with a warning. */
function toOptionalJsonFileValue<Decoded>(
    parsed: ParsedDistributedArtifactPipeline,
    contractFile: ContractJsonFile,
    decodeFile: (value: unknown) => Either<string, Decoded>
): ArtifactFileReading<Decoded | undefined> {
    const file = distributedArtifactPipelineFile(parsed, contractFile.fileName);
    if (file.status === 'missing' || file.status === 'empty') {
        return { value: undefined, warnings: [] };
    }
    return toRequiredJsonFileValue(parsed, contractFile, decodeFile).fold(
        (rejection): ArtifactFileReading<Decoded | undefined> => ({ value: undefined, warnings: [rejection] }),
        (value) => ({ value, warnings: [] })
    );
}

/** A missing, empty or malformed optional file is absent; a malformed one adds a warning. */
function toOptionalJsonFileEvidence<Evidence>(
    parsed: ParsedDistributedArtifactPipeline,
    fileName: string,
    decodeFile: (value: unknown) => Evidence | undefined
): ArtifactFileReading<Evidence | undefined> {
    const file = distributedArtifactPipelineFile(parsed, fileName);
    if (file.format === 'json' && file.status === 'parsed') {
        return { value: decodeFile(file.value), warnings: [] };
    }
    const warnings = file.status === 'missing' || file.status === 'empty'
        ? []
        : [{ fileName, message: `${fileName} is not valid JSON: ${toJsonErrorDetail(fileName, file.message)}` }];
    return { value: undefined, warnings };
}

/** Rows that are not valid JSON or not JSON objects are skipped with a warning each. */
function toJsonlEvidence<Evidence>(
    parsed: ParsedDistributedArtifactPipeline,
    fileName: string,
    decodeRow: (value: unknown) => Evidence | undefined
): ArtifactFileReading<readonly Evidence[]> {
    const readings = distributedArtifactPipelineJsonlRows(parsed, fileName).map(
        (row): ArtifactFileReading<readonly Evidence[]> => {
            if (row.status !== 'parsed') {
                return toJsonlRowWarning(
                    fileName,
                    row.lineNumber,
                    row.message ?? `${fileName}:${row.lineNumber} is not valid JSON.`
                );
            }
            const evidence = decodeRow(row.value);
            return evidence === undefined
                ? toJsonlRowWarning(fileName, row.lineNumber, `${fileName}:${row.lineNumber} is not a JSON object.`)
                : { value: [evidence], warnings: [] };
        }
    );
    return {
        value: readings.flatMap((reading) => reading.value),
        warnings: readings.flatMap((reading) => reading.warnings)
    };
}

function toJsonlRowWarning(
    fileName: string,
    lineNumber: number,
    message: string
): ArtifactFileReading<readonly never[]> {
    return { value: [], warnings: [{ fileName, lineNumber, message }] };
}

/** The control server writes null to target-resolution.json for a run it resolved no targets for. */
function decodeRecordedTargetResolution(value: unknown): Either<string, RecordedTargetResolution> {
    return value === null
        ? Either.ofRight({})
        : decodeTargetResolution(value).mapRight((targetResolution) => ({ targetResolution }));
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
