import { describe, expect, it } from 'vitest';

import { computeSameRegimeComparison, type SameRegimeComparison } from '@shared/measurement/compute-same-regime-comparison.ts';

const BAND: SameRegimeComparison.Band = { relative: 0.1, absolute: 5 };
const REGIME: SameRegimeComparison.Run['regime'] = { apiMode: 'memory', agentCount: 15, 'host.cpuCount': 12, worktreeClean: true };

function createRun(figures: Readonly<Record<string, number>>, regime = REGIME): SameRegimeComparison.Run {
    return { regime, figures };
}

/** One run per side, for the rules that do not depend on how many runs a side holds. */
function compareOneRunEach(baseline: SameRegimeComparison.Run, candidate: SameRegimeComparison.Run) {
    return computeSameRegimeComparison({ baseline: [baseline], candidate: [candidate], band: BAND, minimumRunsPerSide: 1 });
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
        const compared = computeSameRegimeComparison({
            baseline: [71, 54, 67, 66, 68].map((p50) => createRun({ p50 })),
            candidate: [54, 70, 69, 66, 95].map((p50) => createRun({ p50 })),
            band: BAND,
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
        const compared = computeSameRegimeComparison({
            baseline: [60, 62, 64].map((p50) => createRun({ p50 })),
            candidate: [61, 80, 82].map((p50) => createRun({ p50 })),
            band: BAND,
            minimumRunsPerSide: 3
        });

        expect(compared.right?.figures.map((figure) => [figure.baseline, figure.candidate, figure.verdict]))
            .toEqual([[62, 80, 'regression']]);
    });

    it('takes the lower middle run of an even number of runs, with no interpolated value', () => {
        const compared = computeSameRegimeComparison({
            baseline: [10, 40, 20, 30].map((p50) => createRun({ p50 })),
            candidate: [30, 20].map((p50) => createRun({ p50 })),
            band: BAND,
            minimumRunsPerSide: 2
        });

        expect(compared.right?.figures.map((figure) => [figure.baseline, figure.candidate])).toEqual([[20, 20]]);
    });

    it('refuses a side with fewer runs than the caller declared, naming the side, before anything else', () => {
        const three = [1, 2, 3].map((p50) => createRun({ p50 }));
        const two = [1, 2].map((p50) => createRun({ p50 }, { ...REGIME, apiMode: 'postgres' }));

        expect(computeSameRegimeComparison({ baseline: three, candidate: two, band: BAND, minimumRunsPerSide: 3 }).left)
            .toEqual({ kind: 'too-few-runs', keys: ['candidate'] });
        expect(computeSameRegimeComparison({ baseline: two, candidate: two, band: BAND, minimumRunsPerSide: 3 }).left)
            .toEqual({ kind: 'too-few-runs', keys: ['baseline', 'candidate'] });
    });

    it('refuses a side with no run whatever minimum was declared', () => {
        const compared = computeSameRegimeComparison({
            baseline: [],
            candidate: [createRun({ p50: 1 })],
            band: BAND,
            minimumRunsPerSide: 0
        });

        expect(compared.left).toEqual({ kind: 'too-few-runs', keys: ['baseline'] });
    });

    it('refuses when any run of either side is of another regime', () => {
        const compared = computeSameRegimeComparison({
            baseline: [createRun({ p50: 1 }), createRun({ p50: 1 }, { ...REGIME, agentCount: 30 })],
            candidate: [createRun({ p50: 1 }), createRun({ p50: 1 }, { ...REGIME, extra: true })],
            band: BAND,
            minimumRunsPerSide: 2
        });

        expect(compared.left).toEqual({ kind: 'different-regime', keys: ['agentCount', 'extra'] });
    });

    it('refuses when any run lacks a figure another run reports, or reports one that is not finite', () => {
        const missing = computeSameRegimeComparison({
            baseline: [createRun({ p50: 1, runDurationMs: 9 }), createRun({ p50: 1 })],
            candidate: [createRun({ p50: 1, runDurationMs: 9 }), createRun({ p50: 1, runDurationMs: 9 })],
            band: BAND,
            minimumRunsPerSide: 2
        });
        const nonFinite = computeSameRegimeComparison({
            baseline: [createRun({ p50: 1 }), createRun({ p50: 1 })],
            candidate: [createRun({ p50: 1 }), createRun({ p50: Number.NaN })],
            band: BAND,
            minimumRunsPerSide: 2
        });

        expect(missing.left).toEqual({ kind: 'different-figures', keys: ['runDurationMs'] });
        expect(nonFinite.left).toEqual({ kind: 'non-finite-figures', keys: ['p50'] });
    });
});
