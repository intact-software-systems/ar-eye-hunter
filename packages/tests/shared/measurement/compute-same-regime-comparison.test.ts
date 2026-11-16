import { describe, expect, it } from 'vitest';

import { computeSameRegimeComparison, type SameRegimeComparison } from '@shared/measurement/compute-same-regime-comparison.ts';

const BAND: SameRegimeComparison.Band = { relative: 0.1, absolute: 5 };
const REGIME: SameRegimeComparison.Run['regime'] = { apiMode: 'memory', agentCount: 15, 'host.cpuCount': 12, worktreeClean: true };

function createRun(figures: Readonly<Record<string, number>>, regime = REGIME): SameRegimeComparison.Run {
    return { regime, figures };
}

describe('computeSameRegimeComparison', () => {
    it('refuses two runs whose regimes differ, naming every differing key', () => {
        const compared = computeSameRegimeComparison({
            baseline: createRun({ p50: 100 }, { ...REGIME, 'runtime.bun': '1.3.0', onlyInBaseline: 'x' }),
            candidate: createRun({ p50: 100 }, {
                ...REGIME,
                agentCount: 16,
                'host.cpuCount': '12',
                'runtime.bun': '1.3.0',
                apiMode: 'postgres',
                onlyInCandidate: false
            }),
            band: BAND
        });

        expect(compared.left).toEqual({
            kind: 'different-regime',
            keys: ['agentCount', 'apiMode', 'host.cpuCount', 'onlyInBaseline', 'onlyInCandidate']
        });
    });

    it('refuses two runs that do not report the same figures', () => {
        const compared = computeSameRegimeComparison({
            baseline: createRun({ p50: 100, p95: 200, runDurationMs: 9000 }),
            candidate: createRun({ p50: 100, p99: 300, runDurationMs: 9000 }),
            band: BAND
        });

        expect(compared.left).toEqual({ kind: 'different-figures', keys: ['p95', 'p99'] });
    });

    it('names a differing regime before differing figures', () => {
        const compared = computeSameRegimeComparison({
            baseline: createRun({ p50: 100 }),
            candidate: createRun({ p95: 100 }, { ...REGIME, apiMode: 'postgres' }),
            band: BAND
        });

        expect(compared.left).toEqual({ kind: 'different-regime', keys: ['apiMode'] });
    });

    it('calls a figure inside the band noise, above it a regression, below it an improvement', () => {
        const compared = computeSameRegimeComparison({
            baseline: createRun({ steady: 1000, slower: 1000, faster: 1000, atEdge: 1000 }),
            candidate: createRun({ steady: 1080, slower: 1101, faster: 899, atEdge: 1100 }),
            band: BAND
        });

        expect(compared.right?.figures).toEqual([
            { name: 'atEdge', baseline: 1000, candidate: 1100, verdict: 'noise' },
            { name: 'faster', baseline: 1000, candidate: 899, verdict: 'improvement' },
            { name: 'slower', baseline: 1000, candidate: 1101, verdict: 'regression' },
            { name: 'steady', baseline: 1000, candidate: 1080, verdict: 'noise' }
        ]);
    });

    it('treats the band\'s absolute floor as noise for small figures', () => {
        const compared = computeSameRegimeComparison({
            baseline: createRun({ small: 2, zero: 0, grown: 2 }),
            candidate: createRun({ small: 6, zero: 5, grown: 8 }),
            band: BAND
        });

        expect(compared.right?.figures.map((figure) => [figure.name, figure.verdict])).toEqual([
            ['grown', 'regression'],
            ['small', 'noise'],
            ['zero', 'noise']
        ]);
    });

    it('calls a figure that is not a number a regression, as it cannot be shown to be noise', () => {
        const compared = computeSameRegimeComparison({
            baseline: createRun({ unread: 100, unbounded: 100 }),
            candidate: createRun({ unread: Number.NaN, unbounded: Number.POSITIVE_INFINITY }),
            band: BAND
        });

        expect(compared.right?.figures.map((figure) => figure.verdict)).toEqual(['regression', 'regression']);
    });

    it('compares two runs of one regime with no figures as an empty comparison', () => {
        expect(computeSameRegimeComparison({ baseline: createRun({}), candidate: createRun({}), band: BAND }).right)
            .toEqual({ figures: [] });
    });
});
