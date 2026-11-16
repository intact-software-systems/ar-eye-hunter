import { Either } from '../resilience/Either.ts';

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
        readonly verdict: Verdict;
    }

    export interface Refusal {
        readonly kind: 'different-regime' | 'different-figures';
        readonly keys: readonly string[];
    }
}

export interface SameRegimeComparison {
    readonly figures: readonly SameRegimeComparison.Figure[];
}

export interface SameRegimeComparisonInput {
    readonly baseline: SameRegimeComparison.Run;
    readonly candidate: SameRegimeComparison.Run;
    readonly band: SameRegimeComparison.Band;
}

function computeOneSidedKeys(baseline: object, candidate: object): string[] {
    return [
        ...Object.keys(baseline).filter((name) => !Object.hasOwn(candidate, name)),
        ...Object.keys(candidate).filter((name) => !Object.hasOwn(baseline, name))
    ];
}

function computeDifferingRegimeKeys(
    baseline: SameRegimeComparison.Run['regime'],
    candidate: SameRegimeComparison.Run['regime']
): readonly string[] {
    const differing = Object.keys(baseline).filter((name) =>
        Object.hasOwn(candidate, name) && baseline[name] !== candidate[name]
    );
    return [...computeOneSidedKeys(baseline, candidate), ...differing].sort();
}

/** Every figure is lower-is-better; a figure that cannot be shown to sit inside the band is a regression. */
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

export function computeSameRegimeComparison(
    input: SameRegimeComparisonInput
): Either<SameRegimeComparison.Refusal, SameRegimeComparison> {
    const { baseline, candidate, band } = input;
    const regimeKeys = computeDifferingRegimeKeys(baseline.regime, candidate.regime);
    if (regimeKeys.length > 0) {
        return Either.ofLeft({ kind: 'different-regime', keys: regimeKeys });
    }
    const figureKeys = computeOneSidedKeys(baseline.figures, candidate.figures).sort();
    if (figureKeys.length > 0) {
        return Either.ofLeft({ kind: 'different-figures', keys: figureKeys });
    }
    return Either.ofRight({
        figures: Object.keys(baseline.figures).sort().map((name) => ({
            name,
            baseline: baseline.figures[name],
            candidate: candidate.figures[name],
            verdict: computeVerdict(baseline.figures[name], candidate.figures[name], band)
        }))
    });
}
