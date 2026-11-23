import { Either, EitherCollectors } from '@shared/resilience/Either.ts';

import { ALM_CONFORMANCE_CARRIERS, type AlmConformanceCarrier } from '../alm-conformance-carriers.ts';
import type { AlmLanePlanRecord } from '../lane-result/alm-lane-result.ts';
import { ALM_LANE_JOB_NAME_PATTERN, toAlmLaneResultArtifactPrefix } from './alm-lane-workflow-names.ts';
import { computeAlmLaneCarrierConclusion } from './compute-alm-lane-carrier-conclusion.ts';
import type { AlmLaneObservedRun, AlmLaneRunEvent } from './compute-alm-lane-run-reading.ts';
import {
    decodeAlmLaneResultFile,
    type AlmLaneDecodedFile,
    type AlmLaneResultFile
} from './decode-alm-lane-result-file.ts';
import type { AlmLaneReportedJob } from './to-alm-lane-job-conclusion.ts';

const ALM_LANE_RUN_EVENTS: readonly AlmLaneRunEvent[] = ['push', 'pull_request', 'workflow_dispatch'];

/** The events whose completed runs must yield a job per carrier: a pull request's lane jobs may be skipped by design. */
const ALM_LANE_EVENTS_WITH_EVERY_CARRIER: readonly AlmLaneRunEvent[] = ['push', 'workflow_dispatch'];

/** An artifact as GitHub lists it. */
export interface AlmLaneListedArtifact {
    readonly name: string;
    readonly expired: boolean;
}

/** A result artifact name as the ledger reads it: once, however many times the run lists it. */
export interface AlmLaneResolvedArtifact extends AlmLaneListedArtifact {
    /** Above 1 after a rerun: a rerun job uploads again under its name, and a download by name returns one copy. */
    readonly listedCount: number;
}

export interface AlmLaneResultArtifact extends AlmLaneResolvedArtifact {
    /** Null when the artifact has expired or could not be downloaded. */
    readonly files: readonly AlmLaneResultFile[] | null;
}

/** One workflow run as GitHub reports it, with the files of its lane result artifacts. */
export interface ToAlmLaneObservedRunsInput {
    readonly runId: number;
    readonly commitSha: string;
    readonly event: string;
    readonly attempt: number;
    readonly status: string;
    /** Null while the run is in progress. */
    readonly conclusion: string | null;
    readonly jobs: readonly AlmLaneReportedJob[];
    readonly artifacts: readonly AlmLaneResultArtifact[];
}

export interface AlmLaneObservedRunsReading {
    readonly runs: readonly AlmLaneObservedRun[];
    /** What could not be read: an unknown event or carrier, a carrier with no job, and files refused or undecodable. */
    readonly issues: readonly string[];
}

interface AlmLaneJobRead {
    readonly carrier: AlmConformanceCarrier;
    readonly job: AlmLaneReportedJob;
}

interface AlmLaneCarrierRead {
    readonly carrier: AlmConformanceCarrier;
    readonly jobs: readonly [AlmLaneReportedJob, ...AlmLaneReportedJob[]];
}

interface AlmLaneArtifactReading {
    /** False when the artifact has expired or could not be downloaded. */
    readonly read: boolean;
    /** Null when the artifact holds no plan. */
    readonly plan: AlmLanePlanRecord | null;
    readonly results: readonly Extract<AlmLaneDecodedFile, { readonly kind: 'result'; }>[];
    readonly issues: readonly string[];
}

/**
 * The artifacts the ledger reads: each carrier's full-scope lane result, expired or not, each name once with the first
 * listing kept.
 */
export function resolveAlmLaneResultArtifacts(
    artifacts: readonly AlmLaneListedArtifact[]
): readonly AlmLaneResolvedArtifact[] {
    const results = artifacts.filter((artifact) =>
        ALM_CONFORMANCE_CARRIERS.some((carrier) => artifact.name.startsWith(toAlmLaneResultArtifactPrefix(carrier)))
    );
    const firsts = results.filter((artifact, index) =>
        results.findIndex((other) => other.name === artifact.name) === index
    );
    return firsts.map(({ name, expired }) => ({
        name,
        expired,
        listedCount: results.filter((other) => other.name === name).length
    }));
}

/**
 * One observed run per carrier with a lane job; the carrier comes from each job's name, and a carrier's jobs are read
 * together from its artifacts. A run that was skipped yields nothing; a completed push or dispatched run yields a
 * `not-read` run for each carrier with no job.
 */
export function toAlmLaneObservedRuns(input: ToAlmLaneObservedRunsInput): AlmLaneObservedRunsReading {
    const event = ALM_LANE_RUN_EVENTS.find((known) => known === input.event);
    if (event === undefined) {
        return { runs: [], issues: [`run ${input.runId}: event ${input.event} is not one the ledger reads.`] };
    }
    if (input.conclusion === 'skipped') {
        return { runs: [], issues: [] };
    }
    const jobReads = input.jobs.flatMap((job) => toJobRead(input.runId, job));
    const acceptedJobReads = EitherCollectors.toListFoldRights(jobReads);
    const readings = [
        ...EitherCollectors.toListFoldLefts(jobReads).map((issue): AlmLaneObservedRunsReading => ({
            runs: [],
            issues: [issue]
        })),
        ...toCarrierReads(acceptedJobReads).map((read) => toObservedRun(input, event, read)),
        ...resolveCarriersWithoutJob(input, event, acceptedJobReads).map((carrier) =>
            toNotReadRun(input, event, carrier)
        )
    ];
    return { runs: readings.flatMap((reading) => reading.runs), issues: readings.flatMap((reading) => reading.issues) };
}

/** The jobs of each carrier, carriers in the order their first job is listed. */
function toCarrierReads(jobReads: readonly AlmLaneJobRead[]): readonly AlmLaneCarrierRead[] {
    const firsts = jobReads.filter((read, index) =>
        jobReads.findIndex((other) => other.carrier === read.carrier) === index
    );
    return firsts.map((first) => ({
        carrier: first.carrier,
        jobs: [
            first.job,
            ...jobReads.filter((read) => read !== first && read.carrier === first.carrier).map((read) => read.job)
        ]
    }));
}

function resolveCarriersWithoutJob(
    input: ToAlmLaneObservedRunsInput,
    event: AlmLaneRunEvent,
    jobReads: readonly AlmLaneJobRead[]
): readonly AlmConformanceCarrier[] {
    if (input.status !== 'completed' || !ALM_LANE_EVENTS_WITH_EVERY_CARRIER.includes(event)) {
        return [];
    }
    return ALM_CONFORMANCE_CARRIERS.filter((carrier) => !jobReads.some((read) => read.carrier === carrier));
}

function toNotReadRun(
    input: ToAlmLaneObservedRunsInput,
    event: AlmLaneRunEvent,
    carrier: AlmConformanceCarrier
): AlmLaneObservedRunsReading {
    return {
        runs: [{
            runId: input.runId,
            commitSha: input.commitSha,
            event,
            attempt: input.attempt,
            carrier,
            jobConclusion: 'not-read',
            plan: null,
            familyResults: []
        }],
        issues: [`run ${input.runId} ${carrier}: no job of this carrier was read.`]
    };
}

/**
 * No reading for a job that is not a lane job, which includes a job skipped before its matrix expanded, because the
 * job name pattern refuses a name still holding an unevaluated `${{` expression. A lane job naming no known carrier is
 * an issue.
 */
function toJobRead(runId: number, job: AlmLaneReportedJob): readonly Either<string, AlmLaneJobRead>[] {
    const named = ALM_LANE_JOB_NAME_PATTERN.exec(job.name)?.[1];
    if (named === undefined) {
        return [];
    }
    const carrier = ALM_CONFORMANCE_CARRIERS.find((known) => known === named);
    return carrier === undefined
        ? [Either.ofLeft(`run ${runId}: job ${JSON.stringify(job.name)} names no known carrier.`)]
        : [Either.ofRight({ carrier, job })];
}

function toObservedRun(
    input: ToAlmLaneObservedRunsInput,
    event: AlmLaneRunEvent,
    read: AlmLaneCarrierRead
): AlmLaneObservedRunsReading {
    const toIssue = (issue: string) => `run ${input.runId} ${read.carrier}: ${issue}`;
    const prefix = toAlmLaneResultArtifactPrefix(read.carrier);
    const artifacts = input.artifacts.filter((artifact) => artifact.name.startsWith(prefix))
        .map((artifact) => toArtifactReading(artifact, read.carrier));
    const plans = artifacts.flatMap((artifact) => artifact.plan === null ? [] : [artifact.plan]);
    const firstPlan = plans[0];
    const readCount = artifacts.filter((artifact) => artifact.read).length;
    const everyJobRead = readCount === read.jobs.length;
    const results = artifacts.flatMap((artifact) => artifact.results);
    const issues = [
        ...artifacts.flatMap((artifact) => artifact.issues),
        ...(everyJobRead || read.jobs.length === 1 ? [] : [toPlanWithheldIssue(readCount, read.jobs.length)]),
        ...(firstPlan !== undefined && plans.some((plan) => !isSameAlmLanePlan(plan, firstPlan))
            ? [`the plans of this carrier's jobs differ; read the first.`]
            : []),
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
            jobConclusion: computeAlmLaneCarrierConclusion(read.jobs),
            plan: everyJobRead && firstPlan !== undefined ? firstPlan : null,
            familyResults: results.map((result) => result.record)
        }],
        issues: issues.map(toIssue)
    };
}

/** One job's artifact: its first plan, its results, and what could not be read of it. */
function toArtifactReading(artifact: AlmLaneResultArtifact, carrier: AlmConformanceCarrier): AlmLaneArtifactReading {
    const decoded = (artifact.files ?? []).map((file) => decodeAlmLaneResultFile(file, carrier));
    const accepted = EitherCollectors.toListFoldRights(decoded);
    const plans = accepted.flatMap((file) => file.kind === 'plan' ? [file] : []);
    return {
        read: !artifact.expired && artifact.files !== null,
        plan: plans[0]?.record ?? null,
        results: accepted.flatMap((file) => file.kind === 'result' ? [file] : []),
        issues: [
            ...toArtifactIssues(artifact),
            ...EitherCollectors.toListFoldLefts(decoded).flat(),
            ...plans.slice(1).map((plan) => `${plan.fileName} is a second plan.`)
        ]
    };
}

function toArtifactIssues(artifact: AlmLaneResultArtifact): readonly string[] {
    const listed = artifact.listedCount > 1
        ? [
            `artifact ${artifact.name} is listed ${artifact.listedCount} times` +
            ` (a rerun uploads again under its job's name); read once.`
        ]
        : [];
    if (artifact.expired) {
        return [...listed, `artifact ${artifact.name} has expired; history ends at artifact retention.`];
    }
    return artifact.files === null ? [...listed, `artifact ${artifact.name} could not be downloaded.`] : listed;
}

function toPlanWithheldIssue(readCount: number, jobCount: number): string {
    return `${readCount} of ${jobCount} jobs ${
        readCount === 1 ? 'has' : 'have'
    } a readable result artifact; the plan is not read.`;
}

/**
 * Equal plans name the same families with the same scenario keys, in the same order; their identity is the job's, which
 * the decoder already checked.
 */
function isSameAlmLanePlan(left: AlmLanePlanRecord, right: AlmLanePlanRecord): boolean {
    return left.families.length === right.families.length &&
        left.families.every((planned, index) => {
            const other = right.families[index];
            return other?.family === planned.family && other.scenarioKeys.length === planned.scenarioKeys.length &&
                planned.scenarioKeys.every((key, keyIndex) => other.scenarioKeys[keyIndex] === key);
        });
}
