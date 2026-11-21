import { describe, expect, it } from 'vitest';

import { computeSameRegimeComparison, type SameRegimeComparison } from '@shared/measurement/compute-same-regime-comparison.ts';

const BAND: SameRegimeComparison.Band = { relative: 0.1, absolute: 5 };
const REGIME: SameRegimeComparison.Run['regime'] = { apiMode: 'memory', agentCount: 15, 'host.cpuCount': 12, worktreeClean: true };

type UntimedRun = Omit<SameRegimeComparison.Run, 'takenAtEpochMs'>;

interface AlternateComparisonInput {
    readonly baseline: readonly UntimedRun[];
    readonly candidate: readonly UntimedRun[];
    readonly minimumRunsPerSide: number;
}

function createRun(figures: SameRegimeComparison.Run['figures'], regime = REGIME): UntimedRun {
    return { regime, figures };
}

function createRunAt(takenAtEpochMs: number, p50: number): SameRegimeComparison.Run {
    return { takenAtEpochMs, regime: REGIME, figures: { p50 } };
}

/** The sides' runs taken alternately, baseline first: baseline at 0, 2, 4…, candidate at 1, 3, 5…. */
function compareAlternately(input: AlternateComparisonInput) {
    return computeSameRegimeComparison({
        baseline: input.baseline.map((run, index) => ({ ...run, takenAtEpochMs: 2 * index })),
        candidate: input.candidate.map((run, index) => ({ ...run, takenAtEpochMs: 2 * index + 1 })),
        band: BAND,
        minimumRunsPerSide: input.minimumRunsPerSide
    });
}

/** One run per side, for the rules that do not depend on how many runs a side holds. */
function compareOneRunEach(baseline: UntimedRun, candidate: UntimedRun) {
    return compareAlternately({ baseline: [baseline], candidate: [candidate], minimumRunsPerSide: 1 });
}

describe('computeSameRegimeComparison', () => {
    it('refuses two runs whose regimes differ, naming every differing key', () => {
        const compared = compareOneRunEach(
            createRun({ p50: 100 }, { ...REGIME, 'runtime.bun': '1.3.0', onlyInBaseline: 'x' }),
            createRun({ p50: 100 }, {
                ...REGIME,
                agentCount: 16,
                'host.cpuCount': '12',
                'runtime.bun': '1.3.0',
                apiMode: 'postgres',
                onlyInCandidate: false
            })
        );

        expect(compared.left).toEqual({
            kind: 'different-regime',
            keys: ['agentCount', 'apiMode', 'host.cpuCount', 'onlyInBaseline', 'onlyInCandidate']
        });
    });

    it('refuses two runs that do not report the same figures', () => {
        const compared = compareOneRunEach(
            createRun({ p50: 100, p95: 200, runDurationMs: 9000 }),
            createRun({ p50: 100, p99: 300, runDurationMs: 9000 })
        );

        expect(compared.left).toEqual({ kind: 'different-figures', keys: ['p95', 'p99'] });
    });

    it('names a differing regime before differing figures', () => {
        const compared = compareOneRunEach(
            createRun({ p50: 100 }),
            createRun({ p95: 100 }, { ...REGIME, apiMode: 'postgres' })
        );

        expect(compared.left).toEqual({ kind: 'different-regime', keys: ['apiMode'] });
    });

    it('calls a figure inside the band noise, above it a regression, below it an improvement', () => {
        const compared = compareOneRunEach(
            createRun({ steady: 1000, slower: 1000, faster: 1000, atEdge: 1000 }),
            createRun({ steady: 1080, slower: 1101, faster: 899, atEdge: 1100 })
        );

        expect(compared.right?.figures.map((figure) => [figure.name, figure.baseline, figure.candidate, figure.verdict]))
            .toEqual([
                ['atEdge', 1000, 1100, 'noise'],
                ['faster', 1000, 899, 'improvement'],
                ['slower', 1000, 1101, 'regression'],
                ['steady', 1000, 1080, 'noise']
            ]);
    });

    it('treats the band\'s absolute floor as noise for small figures', () => {
        const compared = compareOneRunEach(
            createRun({ small: 2, zero: 0, grown: 2 }),
            createRun({ small: 6, zero: 5, grown: 8 })
        );

        expect(compared.right?.figures.map((figure) => [figure.name, figure.verdict])).toEqual([
            ['grown', 'regression'],
            ['small', 'noise'],
            ['zero', 'noise']
        ]);
    });

    it('refuses figures that are not finite numbers, naming each', () => {
        const compared = compareOneRunEach(
            createRun({ unread: Number.NaN, unbounded: 100, steady: 100 }),
            createRun({ unread: 100, unbounded: Number.POSITIVE_INFINITY, steady: 100 })
        );

        expect(compared.left).toEqual({ kind: 'non-finite-figures', keys: ['unbounded', 'unread'] });
    });

    it('reports a regime difference before a non-finite figure', () => {
        const compared = compareOneRunEach(
            createRun({ unread: Number.NaN }),
            createRun({ unread: 100 }, { ...REGIME, apiMode: 'postgres' })
        );

        expect(compared.left).toEqual({ kind: 'different-regime', keys: ['apiMode'] });
    });

    it('reports a missing figure before a non-finite figure', () => {
        const compared = compareOneRunEach(createRun({ unread: Number.NaN, p95: 100 }), createRun({ unread: 100 }));

        expect(compared.left).toEqual({ kind: 'different-figures', keys: ['p95'] });
    });

    it('compares two runs of one regime with no figures as an empty comparison', () => {
        expect(compareOneRunEach(createRun({}), createRun({})).right).toEqual({ figures: [] });
    });
});

describe('computeSameRegimeComparison over several runs per side', () => {
    // The defect this pins: one run per side read 71 against 54 ms as an improvement and 54 against 67 ms as a
    // regression for one commit (D652). Each side's figure is the median of its runs, so one odd run moves nothing.
    it('compares the median of each side\'s runs and keeps every run\'s value beside it', () => {
        const compared = compareAlternately({
            baseline: [71, 54, 67, 66, 68].map((p50) => createRun({ p50 })),
            candidate: [54, 70, 69, 66, 95].map((p50) => createRun({ p50 })),
            minimumRunsPerSide: 5
        });

        expect(compared.right).toEqual({
            figures: [{
                name: 'p50',
                baseline: 67,
                candidate: 69,
                baselineRuns: [71, 54, 67, 66, 68],
                candidateRuns: [54, 70, 69, 66, 95],
                verdict: 'noise'
            }]
        });
    });

    it('reads a side whose median moved outside the band as a regression', () => {
        const compared = compareAlternately({
            baseline: [60, 62, 64].map((p50) => createRun({ p50 })),
            candidate: [61, 80, 82].map((p50) => createRun({ p50 })),
            minimumRunsPerSide: 3
        });

        expect(compared.right?.figures.map((figure) => [figure.baseline, figure.candidate, figure.verdict]))
            .toEqual([[62, 80, 'regression']]);
    });

    it('takes the lower middle run of an even number of runs, with no interpolated value', () => {
        const compared = compareAlternately({
            baseline: [10, 40, 20, 30].map((p50) => createRun({ p50 })),
            candidate: [35, 15, 25, 45].map((p50) => createRun({ p50 })),
            minimumRunsPerSide: 4
        });

        expect(compared.right?.figures.map((figure) => [figure.baseline, figure.candidate])).toEqual([[20, 25]]);
    });

    it('refuses a side with fewer runs than the caller declared, naming the side, before anything else', () => {
        const three = [1, 2, 3].map((p50) => createRun({ p50 }));
        const two = [1, 2].map((p50) => createRun({ p50 }, { ...REGIME, apiMode: 'postgres' }));

        expect(compareAlternately({ baseline: three, candidate: two, minimumRunsPerSide: 3 }).left)
            .toEqual({ kind: 'too-few-runs', keys: ['candidate'] });
        expect(compareAlternately({ baseline: two, candidate: two, minimumRunsPerSide: 3 }).left)
            .toEqual({ kind: 'too-few-runs', keys: ['baseline', 'candidate'] });
    });

    it('refuses a side with no run whatever minimum was declared', () => {
        const compared = compareAlternately({ baseline: [], candidate: [createRun({ p50: 1 })], minimumRunsPerSide: 0 });

        expect(compared.left).toEqual({ kind: 'too-few-runs', keys: ['baseline'] });
    });

    it('refuses when any run of either side is of another regime', () => {
        const compared = compareAlternately({
            baseline: [createRun({ p50: 1 }), createRun({ p50: 1 }, { ...REGIME, agentCount: 30 })],
            candidate: [createRun({ p50: 1 }), createRun({ p50: 1 }, { ...REGIME, extra: true })],
            minimumRunsPerSide: 2
        });

        expect(compared.left).toEqual({ kind: 'different-regime', keys: ['agentCount', 'extra'] });
    });

    it('refuses when any run lacks a figure another run reports, or reports one that is not finite', () => {
        const missing = compareAlternately({
            baseline: [createRun({ p50: 1, runDurationMs: 9 }), createRun({ p50: 1 })],
            candidate: [createRun({ p50: 1, runDurationMs: 9 }), createRun({ p50: 1, runDurationMs: 9 })],
            minimumRunsPerSide: 2
        });
        const nonFinite = compareAlternately({
            baseline: [createRun({ p50: 1 }), createRun({ p50: 1 })],
            candidate: [createRun({ p50: 1 }), createRun({ p50: Number.NaN })],
            minimumRunsPerSide: 2
        });

        expect(missing.left).toEqual({ kind: 'different-figures', keys: ['runDurationMs'] });
        expect(nonFinite.left).toEqual({ kind: 'non-finite-figures', keys: ['p50'] });
    });
});

function compareTimed(
    baseline: readonly SameRegimeComparison.Run[],
    candidate: readonly SameRegimeComparison.Run[],
    minimumRunsPerSide: number
) {
    return computeSameRegimeComparison({ baseline, candidate, band: BAND, minimumRunsPerSide });
}

// Runs are taken by hand, one at a time on one machine; two blocks of runs let the machine's drift between the blocks
// read as a difference between the builds. Only the instant each run was taken decides the order (D695).
describe('computeSameRegimeComparison over the instants the runs were taken', () => {
    it('compares sides taken alternately whatever order each lists its runs in, and refuses them taken as two blocks', () => {
        const shuffled = compareTimed(
            [[24, 18], [0, 10], [12, 14], [6, 12], [18, 16]].map(([at, p50]) => createRunAt(at, p50)),
            [[15, 25], [3, 21], [27, 29], [9, 23], [21, 27]].map(([at, p50]) => createRunAt(at, p50)),
            5
        );
        const blocks = compareTimed(
            [0, 1, 2, 3, 4].map((at) => createRunAt(at, 10)),
            [5, 6, 7, 8, 9].map((at) => createRunAt(at, 10)),
            5
        );

        expect(shuffled.right).toEqual({
            figures: [{
                name: 'p50',
                baseline: 14,
                candidate: 25,
                baselineRuns: [18, 10, 14, 12, 16],
                candidateRuns: [25, 21, 29, 23, 27],
                verdict: 'regression'
            }]
        });
        expect(blocks.left).toEqual({
            kind: 'sides-not-alternating',
            keys: [
                'baseline',
                'baseline',
                'baseline',
                'baseline',
                'baseline',
                'candidate',
                'candidate',
                'candidate',
                'candidate',
                'candidate'
            ]
        });
    });

    it('compares a baseline side one run longer, and refuses candidate first or a candidate side one run longer', () => {
        const baselineLonger = compareTimed(
            [[0, 10], [2, 12], [4, 14]].map(([at, p50]) => createRunAt(at, p50)),
            [[1, 11], [3, 13]].map(([at, p50]) => createRunAt(at, p50)),
            2
        );
        const candidateFirst = compareTimed([createRunAt(1, 1), createRunAt(3, 1)], [createRunAt(0, 1), createRunAt(2, 1)], 2);
        const candidateLonger = compareTimed(
            [createRunAt(0, 1), createRunAt(2, 1)],
            [createRunAt(1, 1), createRunAt(3, 1), createRunAt(5, 1)],
            2
        );

        expect(baselineLonger.right?.figures.map((figure) => [figure.baseline, figure.candidate])).toEqual([[12, 11]]);
        expect(candidateFirst.left).toEqual({
            kind: 'sides-not-alternating',
            keys: ['candidate', 'baseline', 'candidate', 'baseline']
        });
        expect(candidateLonger.left).toEqual({
            kind: 'sides-not-alternating',
            keys: ['baseline', 'candidate', 'baseline', 'candidate', 'candidate']
        });
    });

    it('refuses two runs taken at one instant, or a run of no finite instant, naming each side that holds one', () => {
        const acrossSides = compareTimed([createRunAt(0, 1), createRunAt(2, 1)], [createRunAt(1, 1), createRunAt(2, 1)], 2);
        const withinBaseline = compareTimed([createRunAt(0, 1), createRunAt(0, 1)], [createRunAt(1, 1), createRunAt(3, 1)], 2);
        const notFinite = [Number.NaN, Number.POSITIVE_INFINITY].map((instant) =>
            compareTimed([createRunAt(0, 1), createRunAt(2, 1)], [createRunAt(1, 1), createRunAt(instant, 1)], 2).left
        );

        expect(acrossSides.left).toEqual({ kind: 'unordered-runs', keys: ['baseline', 'candidate'] });
        expect(withinBaseline.left).toEqual({ kind: 'unordered-runs', keys: ['baseline'] });
        expect(notFinite).toEqual([
            { kind: 'unordered-runs', keys: ['candidate'] },
            { kind: 'unordered-runs', keys: ['candidate'] }
        ]);
    });

    it('reports too few runs before the order of the runs, and the order before a differing regime', () => {
        const tooFew = compareTimed([createRunAt(0, 1)], [createRunAt(0, 1), createRunAt(1, 1)], 2);
        const blocksOfTwoRegimes = compareTimed(
            [createRunAt(0, 1), createRunAt(1, 1)],
            [{ ...createRunAt(2, 1), regime: { ...REGIME, apiMode: 'postgres' } }, createRunAt(3, 1)],
            2
        );

        expect(tooFew.left).toEqual({ kind: 'too-few-runs', keys: ['baseline'] });
        expect(blocksOfTwoRegimes.left).toEqual({
            kind: 'sides-not-alternating',
            keys: ['baseline', 'baseline', 'candidate', 'candidate']
        });
    });
});
