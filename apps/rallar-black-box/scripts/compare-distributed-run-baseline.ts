import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { decodeControlDistributedRunSnapshot } from '@shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-distributed-run-snapshot.ts';
import { decodeControlRunSnapshot } from '@shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-run-snapshot.ts';
import { computeDistributedRunSnapshotPerformance } from '@shared-test/rallar-bb-test/distributed-run-performance/compute-distributed-run-snapshot-performance.ts';
import {
    decodeDistributedRunEnvironment,
    toDistributedRunRegimeKey,
    type DistributedRunEnvironment
} from '@shared-test/rallar-bb-test/distributed-run-performance/distributed-run-environment.ts';
import {
    DISTRIBUTED_RUN_LOCAL_BASELINE_BAND,
    DISTRIBUTED_RUN_LOCAL_BASELINE_MINIMUM_RUNS_PER_SIDE,
    toDistributedRunBaselineFigures
} from '@shared-test/rallar-bb-test/distributed-run-performance/to-distributed-run-baseline-figures.ts';
import { decodePlainRecord } from '@shared/api/exact-object-decoding.ts';
import { getOwnField } from '@shared/encoding/get-own-field.ts';
import {
    computeSameRegimeComparison,
    type SameRegimeComparison
} from '@shared/measurement/compute-same-regime-comparison.ts';
import { Either, Try } from '@shared/resilience/Either.ts';

const USAGE = 'Usage: node --import tsx apps/rallar-black-box/scripts/compare-distributed-run-baseline.ts ' +
    '--baseline <recorder-dir>... --candidate <recorder-dir>...\n' +
    `Each side is at least ${DISTRIBUTED_RUN_LOCAL_BASELINE_MINIMUM_RUNS_PER_SIDE} all-local observation recorder ` +
    'directories of one build: the directories that contain observation/.';

const RUN_FILES = {
    provenance: 'provenance.json',
    controlRun: 'control-run.json',
    distributedRun: 'distributed-run.json'
} as const;

interface LocalBaselineRunTexts {
    readonly recorderDirectory: string;
    readonly provenance: string;
    readonly controlRun: string;
    readonly distributedRun: string;
}

interface LocalBaselineReport {
    readonly lines: readonly string[];
    readonly exitCode: 0 | 1;
}

interface LocalBaselineSides {
    readonly baseline: readonly string[];
    readonly candidate: readonly string[];
}

export function decodeLocalBaselineSides(argv: readonly string[]): Either<string, LocalBaselineSides> {
    const candidateFlagIndex = argv.indexOf('--candidate');
    const baseline = argv.slice(1, Math.max(candidateFlagIndex, 1));
    const candidate = candidateFlagIndex < 0 ? [] : argv.slice(candidateFlagIndex + 1);
    const directories = [...baseline, ...candidate];
    return argv[0] !== '--baseline' ||
            baseline.length === 0 ||
            candidate.length === 0 ||
            directories.some((directory) => directory.startsWith('--'))
        ? Either.ofLeft(USAGE)
        : Either.ofRight({ baseline, candidate });
}

function toRunFilePath(recorderDirectory: string, name: string): string {
    return join(recorderDirectory, 'observation', name);
}

function decodeProvenanceEnvironment(provenance: unknown): Either<readonly string[], DistributedRunEnvironment> {
    const record = decodePlainRecord(provenance).right;
    return decodeDistributedRunEnvironment(record === undefined ? undefined : getOwnField(record, 'environment'))
        .mapLeft((issues) => issues.map((issue) => `environment: ${issue}`));
}

function decodeRunFileText<Value>(
    path: string,
    text: string,
    decodeValue: (value: unknown) => Either<readonly string[], Value>
): Either<readonly string[], Value> {
    return Try.compute(() => JSON.parse(text))
        .fold((error) => Either.ofLeft([`is not JSON: ${error.message}`]), decodeValue)
        .mapLeft((issues) => issues.map((issue) => `${path}: ${issue}`));
}

export function decodeLocalBaselineRun(
    texts: LocalBaselineRunTexts
): Either<readonly string[], SameRegimeComparison.Run> {
    const atPath = (name: string) => toRunFilePath(texts.recorderDirectory, name);
    const environment = decodeRunFileText(atPath(RUN_FILES.provenance), texts.provenance, decodeProvenanceEnvironment);
    const controlRun = decodeRunFileText(
        atPath(RUN_FILES.controlRun),
        texts.controlRun,
        (value) => decodeControlRunSnapshot(value).mapLeft((issue) => [issue])
    );
    const distributedRun = decodeRunFileText(
        atPath(RUN_FILES.distributedRun),
        texts.distributedRun,
        (value) => decodeControlDistributedRunSnapshot(value).mapLeft((issue) => [issue])
    );
    if (environment.right === undefined || controlRun.right === undefined || distributedRun.right === undefined) {
        return Either.ofLeft([...(environment.left ?? []), ...(controlRun.left ?? []), ...(distributedRun.left ?? [])]);
    }
    const performance = computeDistributedRunSnapshotPerformance({
        controlRun: controlRun.right,
        distributedRun: distributedRun.right
    });
    return Either.ofRight({
        regime: toDistributedRunRegimeKey(environment.right),
        figures: toDistributedRunBaselineFigures(performance)
    });
}

const REFUSAL_REASONS: Readonly<Record<SameRegimeComparison.Refusal['kind'], string>> = {
    'too-few-runs': `fewer than ${DISTRIBUTED_RUN_LOCAL_BASELINE_MINIMUM_RUNS_PER_SIDE} runs on`,
    'different-regime': 'the regimes differ in',
    'different-figures': 'not every run reports',
    'non-finite-figures': 'a run reports a figure that is not a finite number:'
};

function toRefusalLine(refusal: SameRegimeComparison.Refusal): string {
    return `not comparable: ${REFUSAL_REASONS[refusal.kind]} ${refusal.keys.join(', ')}`;
}

function toComparisonReport(comparison: SameRegimeComparison): LocalBaselineReport {
    if (comparison.figures.length === 0) {
        return { lines: ['not comparable: no run reports a figure'], exitCode: 1 };
    }
    const lines = comparison.figures.map((figure) =>
        `${figure.name} baseline ${figure.baseline} (${figure.baselineRuns.join(', ')}) ` +
        `candidate ${figure.candidate} (${figure.candidateRuns.join(', ')}) ${figure.verdict}`
    );
    const regressed = comparison.figures.filter((figure) => figure.verdict === 'regression');
    return regressed.length === 0
        ? { lines, exitCode: 0 }
        : { lines: [...lines, `regression in ${regressed.map((figure) => figure.name).join(', ')}`], exitCode: 1 };
}

export function toLocalBaselineReport(
    compared: Either<SameRegimeComparison.Refusal, SameRegimeComparison>
): LocalBaselineReport {
    return compared.fold((refusal) => ({ lines: [toRefusalLine(refusal)], exitCode: 1 }), toComparisonReport);
}

async function readRunFileText(recorderDirectory: string, name: string): Promise<Either<string, string>> {
    const path = toRunFilePath(recorderDirectory, name);
    try {
        return Either.ofRight(await readFile(path, 'utf8'));
    }
    catch (error) {
        return Either.ofLeft(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

async function readLocalBaselineRun(
    recorderDirectory: string
): Promise<Either<readonly string[], SameRegimeComparison.Run>> {
    const [provenance, controlRun, distributedRun] = await Promise.all([
        readRunFileText(recorderDirectory, RUN_FILES.provenance),
        readRunFileText(recorderDirectory, RUN_FILES.controlRun),
        readRunFileText(recorderDirectory, RUN_FILES.distributedRun)
    ]);
    if (provenance.right === undefined || controlRun.right === undefined || distributedRun.right === undefined) {
        return Either.ofLeft(
            [provenance.left, controlRun.left, distributedRun.left].filter((issue) => issue !== undefined)
        );
    }
    return decodeLocalBaselineRun({
        recorderDirectory,
        provenance: provenance.right,
        controlRun: controlRun.right,
        distributedRun: distributedRun.right
    });
}

async function readLocalBaselineSide(
    recorderDirectories: readonly string[]
): Promise<Either<readonly string[], readonly SameRegimeComparison.Run[]>> {
    const runs = await Promise.all(recorderDirectories.map(readLocalBaselineRun));
    const issues = runs.flatMap((run) => run.left ?? []);
    return issues.length > 0
        ? Either.ofLeft(issues)
        : Either.ofRight(runs.flatMap((run) => (run.right === undefined ? [] : [run.right])));
}

async function main(): Promise<void> {
    const sides = decodeLocalBaselineSides(process.argv.slice(2));
    if (sides.right === undefined) {
        console.error(sides.left);
        process.exitCode = 1;
        return;
    }
    const [baseline, candidate] = await Promise.all([
        readLocalBaselineSide(sides.right.baseline),
        readLocalBaselineSide(sides.right.candidate)
    ]);
    if (baseline.right === undefined || candidate.right === undefined) {
        [...(baseline.left ?? []), ...(candidate.left ?? [])].forEach((issue) => console.error(issue));
        process.exitCode = 1;
        return;
    }
    const report = toLocalBaselineReport(computeSameRegimeComparison({
        baseline: baseline.right,
        candidate: candidate.right,
        band: DISTRIBUTED_RUN_LOCAL_BASELINE_BAND,
        minimumRunsPerSide: DISTRIBUTED_RUN_LOCAL_BASELINE_MINIMUM_RUNS_PER_SIDE
    }));
    report.lines.forEach((line) => (report.exitCode === 0 ? console.log(line) : console.error(line)));
    process.exitCode = report.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
