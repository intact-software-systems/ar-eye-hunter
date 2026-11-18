import { Either } from '../resilience/Either.ts';
import { computeNearestRank } from './compute-nearest-rank.ts';

export namespace SameRegimeComparison {
    export interface Run {
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
        readonly kind: 'too-few-runs' | 'different-regime' | 'different-figures' | 'non-finite-figures';
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

function computeShortSides(input: SameRegimeComparisonInput): readonly string[] {
    const isShort = (runs: readonly SameRegimeComparison.Run[]) =>
        runs.length === 0 || runs.length < input.minimumRunsPerSide;
    return [
        ...(isShort(input.baseline) ? ['baseline'] : []),
        ...(isShort(input.candidate) ? ['candidate'] : [])
    ];
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
