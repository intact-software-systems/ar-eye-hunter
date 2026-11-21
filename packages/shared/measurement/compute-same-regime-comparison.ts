import { Either } from '../resilience/Either.ts';
import { computeNearestRank } from './compute-nearest-rank.ts';

export namespace SameRegimeComparison {
    export interface Run {
        readonly takenAtEpochMs: number;
        readonly regime: Readonly<Record<string, string | number | boolean>>;
        readonly figures: Readonly<Record<string, number>>;
    }

    export interface Band {
        readonly relative: number;
        readonly absolute: number;
    }

    export type Verdict = 'noise' | 'regression' | 'improvement';

    export interface Figure {
        readonly name: string;
        readonly baseline: number;
        readonly candidate: number;
        readonly baselineRuns: readonly number[];
        readonly candidateRuns: readonly number[];
        readonly verdict: Verdict;
    }

    export interface Refusal {
        readonly kind:
            | 'too-few-runs'
            | 'unordered-runs'
            | 'sides-not-alternating'
            | 'different-regime'
            | 'different-figures'
            | 'non-finite-figures';
        readonly keys: readonly string[];
    }
}

export interface SameRegimeComparison {
    readonly figures: readonly SameRegimeComparison.Figure[];
}

interface SameRegimeComparisonInput {
    readonly baseline: readonly SameRegimeComparison.Run[];
    readonly candidate: readonly SameRegimeComparison.Run[];
    readonly band: SameRegimeComparison.Band;
    readonly minimumRunsPerSide: number;
}

const SIDES = ['baseline', 'candidate'] as const;

interface TakenRun {
    readonly side: (typeof SIDES)[number];
    readonly takenAtEpochMs: number;
}

function computeShortSides(input: SameRegimeComparisonInput): readonly string[] {
    return SIDES.filter((side) => input[side].length === 0 || input[side].length < input.minimumRunsPerSide);
}

function toTakenRuns(input: SameRegimeComparisonInput): readonly TakenRun[] {
    return SIDES.flatMap((side) => input[side].map((run) => ({ side, takenAtEpochMs: run.takenAtEpochMs })));
}

function computeUnorderedSides(runs: readonly TakenRun[]): readonly string[] {
    const isUnordered = (run: TakenRun) =>
        !Number.isFinite(run.takenAtEpochMs) ||
        runs.some((other) => other !== run && other.takenAtEpochMs === run.takenAtEpochMs);
    return SIDES.filter((side) => runs.some((run) => run.side === side && isUnordered(run)));
}

function computeOrderRefusal(runs: readonly TakenRun[]): SameRegimeComparison.Refusal | undefined {
    const unorderedSides = computeUnorderedSides(runs);
    if (unorderedSides.length > 0) {
        return { kind: 'unordered-runs', keys: unorderedSides };
    }
    const runsInOrderTaken = [...runs].sort((first, second) => first.takenAtEpochMs - second.takenAtEpochMs);
    const sidesInOrderTaken = runsInOrderTaken.map((run) => run.side);
    return sidesInOrderTaken.every((side, index) => side === SIDES[index % SIDES.length])
        ? undefined
        : { kind: 'sides-not-alternating', keys: sidesInOrderTaken };
}

function computeAllKeys(records: readonly object[]): readonly string[] {
    return [...new Set(records.flatMap((record) => Object.keys(record)))].sort();
}

function computeDifferingRegimeKeys(regimes: readonly SameRegimeComparison.Run['regime'][]): readonly string[] {
    return computeAllKeys(regimes).filter((name) =>
        regimes.some((regime) => !Object.hasOwn(regime, name) || regime[name] !== regimes[0][name])
    );
}

function computeUnsharedFigureKeys(figures: readonly SameRegimeComparison.Run['figures'][]): readonly string[] {
    return computeAllKeys(figures).filter((name) => figures.some((run) => !Object.hasOwn(run, name)));
}

/** Every figure is lower-is-better. */
function computeVerdict(
    baseline: number,
    candidate: number,
    band: SameRegimeComparison.Band
): SameRegimeComparison.Verdict {
    if (Math.abs(candidate - baseline) <= Math.max(band.absolute, band.relative * Math.abs(baseline))) {
        return 'noise';
    }
    return candidate < baseline ? 'improvement' : 'regression';
}

function computeSideMedian(runs: readonly number[]): number {
    const median = computeNearestRank(runs, 0.5);
    if (median === undefined) {
        throw new Error('A compared side holds at least one run.');
    }
    return median;
}

function computeFigure(name: string, input: SameRegimeComparisonInput): SameRegimeComparison.Figure {
    const baselineRuns = input.baseline.map((run) => run.figures[name]);
    const candidateRuns = input.candidate.map((run) => run.figures[name]);
    const baseline = computeSideMedian(baselineRuns);
    const candidate = computeSideMedian(candidateRuns);
    return {
        name,
        baseline,
        candidate,
        baselineRuns,
        candidateRuns,
        verdict: computeVerdict(baseline, candidate, input.band)
    };
}

export function computeSameRegimeComparison(
    input: SameRegimeComparisonInput
): Either<SameRegimeComparison.Refusal, SameRegimeComparison> {
    const shortSides = computeShortSides(input);
    if (shortSides.length > 0) {
        return Either.ofLeft({ kind: 'too-few-runs', keys: shortSides });
    }
    const orderRefusal = computeOrderRefusal(toTakenRuns(input));
    if (orderRefusal !== undefined) {
        return Either.ofLeft(orderRefusal);
    }
    const runs = [...input.baseline, ...input.candidate];
    const regimeKeys = computeDifferingRegimeKeys(runs.map((run) => run.regime));
    if (regimeKeys.length > 0) {
        return Either.ofLeft({ kind: 'different-regime', keys: regimeKeys });
    }
    const figures = runs.map((run) => run.figures);
    const unsharedKeys = computeUnsharedFigureKeys(figures);
    if (unsharedKeys.length > 0) {
        return Either.ofLeft({ kind: 'different-figures', keys: unsharedKeys });
    }
    const names = computeAllKeys(figures);
    const nonFiniteKeys = names.filter((name) => figures.some((run) => !Number.isFinite(run[name])));
    if (nonFiniteKeys.length > 0) {
        return Either.ofLeft({ kind: 'non-finite-figures', keys: nonFiniteKeys });
    }
    return Either.ofRight({ figures: names.map((name) => computeFigure(name, input)) });
}
