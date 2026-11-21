import { Either, EitherCollectors } from '@shared/resilience/Either.ts';

import { ALM_CONFORMANCE_CARRIERS, type AlmConformanceCarrier } from '../alm-conformance-carriers.ts';
import type { AlmLaneFamilyResult, AlmLanePlanRecord, AlmLaneRunIdentity } from '../lane-result/alm-lane-result.ts';
import { decodeAlmLaneFamilyResult, decodeAlmLanePlanRecord } from '../lane-result/decode-alm-lane-result.ts';
import type { AlmLaneObservedRun, AlmLaneRunEvent } from './compute-alm-lane-ledger.ts';
import { toAlmLaneJobConclusion, type AlmLaneReportedJob } from './to-alm-lane-job-conclusion.ts';

const ALM_LANE_JOB_NAME_PATTERN = /^ALM conformance observation \((.*)\)$/;

const ALM_LANE_RUN_EVENTS: readonly AlmLaneRunEvent[] = ['push', 'pull_request', 'workflow_dispatch'];

/** The scope whose runs the ledger reads. */
const ALM_LANE_LEDGER_SCOPE = 'full';

export interface AlmLaneResultFile {
    readonly fileName: string;
    readonly text: string;
}

export interface AlmLaneResultArtifact {
    readonly name: string;
    readonly files: readonly AlmLaneResultFile[];
}

/** One workflow run as GitHub reports it, with the files of its lane result artifacts. */
export interface ToAlmLaneObservedRunsInput {
    readonly runId: number;
    readonly commitSha: string;
    readonly event: string;
    readonly attempt: number;
    readonly jobs: readonly AlmLaneReportedJob[];
    readonly artifacts: readonly AlmLaneResultArtifact[];
}

export interface AlmLaneObservedRunsReading {
    readonly runs: readonly AlmLaneObservedRun[];
    /** What could not be read: an unknown event or carrier, and files refused or that did not decode. */
    readonly issues: readonly string[];
}

/** A decoded file before its identity is checked against the job. */
type AlmLaneDecodedFile =
    | { readonly kind: 'plan'; readonly fileName: string; readonly record: AlmLanePlanRecord; }
    | { readonly kind: 'result'; readonly fileName: string; readonly record: AlmLaneFamilyResult; };

interface AlmLaneJobRead {
    readonly carrier: AlmConformanceCarrier;
    readonly job: AlmLaneReportedJob;
}

/** The artifacts the ledger downloads: each carrier's full-scope lane result. */
export function resolveAlmLaneResultArtifactNames(artifactNames: readonly string[]): readonly string[] {
    return artifactNames.filter((name) =>
        ALM_CONFORMANCE_CARRIERS.some((carrier) => name.startsWith(toArtifactPrefix(carrier)))
    );
}

/** One observed run per lane job; the carrier comes from the job's name, and each job reads its own artifact. */
export function toAlmLaneObservedRuns(input: ToAlmLaneObservedRunsInput): AlmLaneObservedRunsReading {
    const event = ALM_LANE_RUN_EVENTS.find((known) => known === input.event);
    if (event === undefined) {
        return { runs: [], issues: [`run ${input.runId}: event ${input.event} is not one the ledger reads.`] };
    }
    const readings = input.jobs.flatMap((job) => toJobRead(input.runId, job)).map((read) =>
        read.fold(
            (issue): AlmLaneObservedRunsReading => ({ runs: [], issues: [issue] }),
            (jobRead) => toObservedRun(input, event, jobRead)
        )
    );
    return { runs: readings.flatMap((reading) => reading.runs), issues: readings.flatMap((reading) => reading.issues) };
}

/** No reading for a job that is not a lane job, or a skipped one whose matrix name GitHub never expanded. */
function toJobRead(runId: number, job: AlmLaneReportedJob): readonly Either<string, AlmLaneJobRead>[] {
    const named = ALM_LANE_JOB_NAME_PATTERN.exec(job.name)?.[1];
    if (named === undefined) {
        return [];
    }
    const carrier = ALM_CONFORMANCE_CARRIERS.find((known) => known === named);
    if (carrier !== undefined) {
        return [Either.ofRight({ carrier, job })];
    }
    return toAlmLaneJobConclusion(job) === 'skipped'
        ? []
        : [Either.ofLeft(`run ${runId}: job ${JSON.stringify(job.name)} names no known carrier.`)];
}

function toObservedRun(
    input: ToAlmLaneObservedRunsInput,
    event: AlmLaneRunEvent,
    read: AlmLaneJobRead
): AlmLaneObservedRunsReading {
    const toIssue = (issue: string) => `run ${input.runId} ${read.carrier}: ${issue}`;
    const artifacts = input.artifacts.filter((artifact) => artifact.name.startsWith(toArtifactPrefix(read.carrier)));
    const decoded = (artifacts[0]?.files ?? []).map((file) => toDecodedFile(file, read.carrier));
    const accepted = EitherCollectors.toListFoldRights(decoded);
    const plans = accepted.flatMap((file) => file.kind === 'plan' ? [file] : []);
    const results = accepted.flatMap((file) => file.kind === 'result' ? [file] : []);
    const issues = [
        ...(artifacts.length > 1 ? [toArtifactsIssue(artifacts)] : []),
        ...EitherCollectors.toListFoldLefts(decoded).flat(),
        ...plans.slice(1).map((plan) => `${plan.fileName} is a second plan.`),
        ...results.filter((result, index) =>
            results.findIndex((other) => other.record.family === result.record.family) !== index
        )
            .map((result) => `${result.fileName} is a second result for family ${result.record.family}.`)
    ];
    return {
        runs: [{
            runId: input.runId,
            commitSha: input.commitSha,
            event,
            attempt: input.attempt,
            carrier: read.carrier,
            jobConclusion: toAlmLaneJobConclusion(read.job),
            plan: plans[0]?.record ?? null,
            familyResults: results.map((result) => result.record)
        }],
        issues: issues.map(toIssue)
    };
}

/** A file whose name ends in `-plan.json` is a plan; every other file is a family result. */
function toDecodedFile(
    file: AlmLaneResultFile,
    carrier: AlmConformanceCarrier
): Either<readonly string[], AlmLaneDecodedFile> {
    return decodeAlmLaneFile(file).fold(
        (issues) => Either.ofLeft(issues.map((issue) => `${file.fileName}${issue}`)),
        (accepted) => validateIdentity(accepted, carrier)
    );
}

/** Each issue reads after the file's name. */
function decodeAlmLaneFile(file: AlmLaneResultFile): Either<readonly string[], AlmLaneDecodedFile> {
    let value: unknown;
    try {
        value = JSON.parse(file.text);
    }
    catch {
        return Either.ofLeft([' is not JSON.']);
    }
    const toIssues = (issues: readonly string[]) => issues.map((issue) => `: ${issue}`);
    if (file.fileName.endsWith('-plan.json')) {
        return decodeAlmLanePlanRecord(value).mapBoth(
            toIssues,
            (record): AlmLaneDecodedFile => ({ kind: 'plan', fileName: file.fileName, record })
        );
    }
    return decodeAlmLaneFamilyResult(value).mapBoth(
        toIssues,
        (record): AlmLaneDecodedFile => ({ kind: 'result', fileName: file.fileName, record })
    );
}

function validateIdentity(
    file: AlmLaneDecodedFile,
    carrier: AlmConformanceCarrier
): Either<readonly string[], AlmLaneDecodedFile> {
    if (file.record.carrier === carrier && file.record.scope === ALM_LANE_LEDGER_SCOPE) {
        return Either.ofRight(file);
    }
    const expected: Pick<AlmLaneRunIdentity, 'carrier' | 'scope'> = { carrier, scope: ALM_LANE_LEDGER_SCOPE };
    return Either.ofLeft([
        `${file.fileName} is for ${toIdentityText(file.record)}; the job is for ${toIdentityText(expected)}.`
    ]);
}

function toIdentityText(identity: Pick<AlmLaneRunIdentity, 'carrier' | 'scope'>): string {
    return `carrier ${identity.carrier} and scope ${identity.scope}`;
}

function toArtifactsIssue(artifacts: readonly AlmLaneResultArtifact[]): string {
    return `${artifacts.length} result artifacts (${
        artifacts.map((artifact) => artifact.name).join(', ')
    }); read the first.`;
}

function toArtifactPrefix(carrier: AlmConformanceCarrier): string {
    return `alm-lane-result-${carrier}-${ALM_LANE_LEDGER_SCOPE}-`;
}
