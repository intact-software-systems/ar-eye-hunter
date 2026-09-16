import { Either } from '@shared/resilience/Either.ts';

import type { ControlDistributedRunSnapshot, ControlRunSnapshot } from '../control-snapshots.ts';
import type {
    DistributedRunArtifactParseWarning,
    DistributedRunArtifactRejection
} from '../distributed-artifact-analysis.ts';
import {
    distributedArtifactPipelineFile,
    distributedArtifactPipelineJsonlRows,
    type ParsedDistributedArtifactPipeline
} from '../distributed-artifact-pipeline.ts';
import type { RallarBlackBoxDistributedTargetResolution } from '../distributed-run.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import {
    toJsonlEvidence,
    toOptionalJsonFileEvidence,
    toOptionalJsonFileValue,
    toRequiredJsonFileValue,
    type ArtifactFileReading
} from './artifact-file-reading.ts';
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
    readonly response: ControlPostFailureResponse;
}

/**
 * What the artifacts hold of a failed request's response body. The runner keeps whatever body the
 * control server or a proxy returned, so a recorded body need not be JSON.
 */
export type ControlPostFailureResponse =
    | Readonly<{ kind: 'none'; }>
    | Readonly<{ kind: 'missing-file'; fileName: string; }>
    | ControlPostFailureJsonBody
    | Readonly<{ kind: 'text'; fileName: string; text: string; }>;

export interface ControlPostFailureJsonBody {
    readonly kind: 'json';
    readonly fileName: string;
    readonly text: string;
    /** Absent when the body is not a JSON object naming an error message. */
    readonly message?: string;
}

export interface DistributedRunBundleContent {
    readonly variant: 'distributed-run';
    /** The optional evidence readings' warnings; an unavailable control run carries its own reason. */
    readonly parseWarnings: readonly DistributedRunArtifactParseWarning[];
    readonly distributedRun: ControlDistributedRunSnapshot;
    readonly controlRun: DistributedRunControlRunReading;
    /** Absent when fleet-report.json is missing, empty, not valid JSON or not a JSON object. */
    readonly fleetReport?: DistributedRunFleetReportEvidence;
    /** Absent when failures.json lists no failures. */
    readonly bundledFailure?: DistributedRunBundledFailure;
    /** Absent when target-resolution.json is missing, records null, or is not a target resolution; a warning says which. */
    readonly targetResolution?: RallarBlackBoxDistributedTargetResolution;
    /** Absent when the runner recorded no failed control request or its record is malformed; a warning says which. */
    readonly controlPostFailure?: ControlPostFailureArtifact;
    readonly results: readonly DistributedRunResultEvidence[];
    readonly events: readonly DistributedRunEventEvidence[];
}

export interface DistributedRunControlRequestFailureContent {
    readonly variant: 'control-request-failure';
    readonly parseWarnings: readonly DistributedRunArtifactParseWarning[];
    readonly controlPostFailure: ControlPostFailureArtifact;
    /** Absent when the runner stopped before it wrote runner-summary.json or the summary is malformed; a warning says which. */
    readonly runnerSummary?: DistributedRunRunnerSummary;
    /** Absent when manifest.json is missing, or is malformed or names no distributed run; a warning says which. */
    readonly manifestDistributedRunId?: string;
}

/**
 * control-run.json is optional evidence: the Hetzner runner exports it only when it has a control run id
 * and can fetch the run, so a missing or malformed file leaves the control run unavailable.
 */
export type DistributedRunControlRunReading =
    | Readonly<{ status: 'recorded'; snapshot: ControlRunSnapshot; }>
    | Readonly<{ status: 'unavailable'; reason: DistributedRunArtifactParseWarning; }>;

export type DistributedRunArtifactContent =
    | DistributedRunBundleContent
    | DistributedRunControlRequestFailureContent;

const CONTROL_POST_ERROR_METADATA_FILE_NAME = 'control-post-error-metadata.json';

const DISTRIBUTED_RUN_FILE = { fileName: 'distributed-run.json', contractName: 'a distributed run snapshot' } as const;

const CONTROL_RUN_FILE = { fileName: 'control-run.json', contractName: 'a control run snapshot' } as const;

const CONTROL_POST_REQUEST_FILE = {
    fileName: CONTROL_POST_ERROR_METADATA_FILE_NAME,
    contractName: 'a control request record'
} as const;

interface RecordedTargetResolution {
    /** Absent when target-resolution.json records null. */
    readonly targetResolution?: RallarBlackBoxDistributedTargetResolution;
}

/**
 * A folder without distributed-run.json is analyzable only when the runner recorded the failed
 * control request that prevented the run from existing; that record is then required, while beside a
 * distributed run it is optional evidence.
 */
export function toDistributedRunArtifactContent(
    parsed: ParsedDistributedArtifactPipeline
): Either<DistributedRunArtifactRejection, DistributedRunArtifactContent> {
    if (distributedArtifactPipelineFile(parsed, 'distributed-run.json').status !== 'missing') {
        return toBundleContent(parsed);
    }
    if (distributedArtifactPipelineFile(parsed, CONTROL_POST_ERROR_METADATA_FILE_NAME).status === 'missing') {
        return Either.ofLeft({
            fileName: 'distributed-run.json',
            message:
                'distributed-run.json is required: the artifacts hold neither a distributed run snapshot nor a failed control request record.'
        });
    }
    return toRequiredJsonFileValue(parsed, CONTROL_POST_REQUEST_FILE, decodeControlPostRequest)
        .mapRight((request) => toControlRequestFailureContent(parsed, toControlPostFailure(parsed, request)));
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
    parsed: ParsedDistributedArtifactPipeline
): Either<DistributedRunArtifactRejection, DistributedRunArtifactContent> {
    return toRequiredJsonFileValue(parsed, DISTRIBUTED_RUN_FILE, decodeControlDistributedRunSnapshot)
        .mapRight((distributedRun) => {
            const recorded = toOptionalControlPostFailure(parsed);
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
                distributedRun,
                controlRun: toControlRunReading(parsed),
                ...(fleetReport.value === undefined ? {} : { fleetReport: fleetReport.value }),
                ...(bundledFailure.value === undefined ? {} : { bundledFailure: bundledFailure.value }),
                ...targetResolution.value,
                ...(recorded.value === undefined ? {} : { controlPostFailure: recorded.value }),
                results: results.value,
                events: events.value
            };
        });
}

function toControlRunReading(parsed: ParsedDistributedArtifactPipeline): DistributedRunControlRunReading {
    const file = distributedArtifactPipelineFile(parsed, CONTROL_RUN_FILE.fileName);
    if (file.status === 'missing' || file.status === 'empty') {
        return {
            status: 'unavailable',
            reason: {
                fileName: CONTROL_RUN_FILE.fileName,
                message: 'control-run.json is missing or empty, so the artifacts hold no control run snapshot.'
            }
        };
    }
    return toRequiredJsonFileValue(parsed, CONTROL_RUN_FILE, decodeControlRunSnapshot).fold(
        (reason): DistributedRunControlRunReading => ({ status: 'unavailable', reason }),
        (snapshot) => ({ status: 'recorded', snapshot: toControlRunWithJsonlEnvelopes(parsed, snapshot) })
    );
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

/** The runner summary and manifest are optional evidence of the run that was never created. */
function toControlRequestFailureContent(
    parsed: ParsedDistributedArtifactPipeline,
    recorded: ArtifactFileReading<ControlPostFailureArtifact>
): DistributedRunControlRequestFailureContent {
    const manifestDistributedRunId = toOptionalJsonFileValue(
        parsed,
        { fileName: 'manifest.json', contractName: 'a distributed run manifest' },
        decodeManifestDistributedRunId
    );
    const runnerSummary = toOptionalJsonFileValue(
        parsed,
        { fileName: 'runner-summary.json', contractName: 'a runner summary' },
        decodeDistributedRunRunnerSummary
    );
    return {
        variant: 'control-request-failure',
        parseWarnings: [recorded, runnerSummary, manifestDistributedRunId].flatMap((reading) => reading.warnings),
        controlPostFailure: recorded.value,
        ...(runnerSummary.value === undefined ? {} : { runnerSummary: runnerSummary.value }),
        ...(manifestDistributedRunId.value === undefined
            ? {}
            : { manifestDistributedRunId: manifestDistributedRunId.value })
    };
}

function toOptionalControlPostFailure(
    parsed: ParsedDistributedArtifactPipeline
): ArtifactFileReading<ControlPostFailureArtifact | undefined> {
    const request = toOptionalJsonFileValue(parsed, CONTROL_POST_REQUEST_FILE, decodeControlPostRequest);
    if (request.value === undefined) {
        return { value: undefined, warnings: request.warnings };
    }
    return toControlPostFailure(parsed, request.value);
}

function toControlPostFailure(
    parsed: ParsedDistributedArtifactPipeline,
    request: DistributedRunControlPostRequest
): ArtifactFileReading<ControlPostFailureArtifact> {
    const responseFile = request.responseFile;
    if (responseFile === undefined) {
        return { value: { request, response: { kind: 'none' } }, warnings: [] };
    }
    const text = parsed.projectedFiles[responseFile];
    if (text === undefined) {
        return {
            value: { request, response: { kind: 'missing-file', fileName: responseFile } },
            warnings: [{
                fileName: responseFile,
                message:
                    `${responseFile} is named by ${CONTROL_POST_ERROR_METADATA_FILE_NAME} but is not among the artifact files.`
            }]
        };
    }
    return { value: { request, response: toControlPostFailureResponseBody(parsed, responseFile, text) }, warnings: [] };
}

function toControlPostFailureResponseBody(
    parsed: ParsedDistributedArtifactPipeline,
    fileName: string,
    text: string
): ControlPostFailureResponse {
    const file = distributedArtifactPipelineFile(parsed, fileName);
    if (file.format !== 'json' || file.status !== 'parsed') {
        return { kind: 'text', fileName, text };
    }
    const message = decodeControlResponseMessage(file.value);
    return { kind: 'json', fileName, text, ...(message === undefined ? {} : { message }) };
}

/** The control server writes null to target-resolution.json for a run it resolved no targets for. */
function decodeRecordedTargetResolution(value: unknown): Either<string, RecordedTargetResolution> {
    return value === null
        ? Either.ofRight({})
        : decodeTargetResolution(value).mapRight((targetResolution) => ({ targetResolution }));
}

/** Absent unless the body is a JSON object naming an error message. */
function decodeControlResponseMessage(value: unknown): string | undefined {
    if (!isJsonRecordValue(value)) {
        return undefined;
    }
    const error = isJsonRecordValue(value.error) ? value.error : undefined;
    return decodeText(value.message) ?? decodeText(error?.message) ?? decodeText(value.error) ??
        decodeText(value.detail) ?? decodeText(value.title);
}

/** A run that was never created has no decoded manifest; only the run id the runner validated is read. */
function decodeManifestDistributedRunId(value: unknown): Either<string, string> {
    if (!isJsonRecordValue(value)) {
        return Either.ofLeft('the manifest must be a JSON object');
    }
    const distributedRunId = decodeText(value.distributedRunId);
    return distributedRunId === undefined
        ? Either.ofLeft('distributedRunId must be a non-empty string')
        : Either.ofRight(distributedRunId);
}
