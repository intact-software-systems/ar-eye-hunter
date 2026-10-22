import {
    describe,
    expect,
    it
} from 'vitest';

import { toV1dGrowthVerdictMarkdown } from '../../../shared-test/rallar-bb-test/alm/growth-proof/to-v1d-growth-verdict-markdown.ts';

describe('V1d growth verdict document', () => {
    it('tables every reading with its class, plateau, slope, max, bound and verdict, and lists the reasons', () => {
        const markdown = toV1dGrowthVerdictMarkdown({
            skippedLines: 1,
            verdict: {
                passed: false,
                rows: [
                    {
                        surfaceId: 8,
                        surface: 'idempotent rows',
                        reader: 'postgres runtimeState.byNamespace.group-state:idempotent',
                        growthClass: 'ttl-within-run',
                        bound: 'ttl 1800 s + sweep 60 s',
                        firstPlateau: { atElapsedMs: 1_860_000, value: 4_200 },
                        slopePerHour: 12_000,
                        max: 7_200,
                        outcome: 'fail',
                        reason: 'still rising after ttl + sweep'
                    },
                    {
                        surfaceId: null,
                        surface: 'runtime_state_store namespace a|b',
                        reader: 'none',
                        growthClass: 'unclassified',
                        bound: 'none',
                        firstPlateau: null,
                        slopePerHour: null,
                        max: null,
                        outcome: 'unclassified',
                        reason: 'no class'
                    }
                ]
            }
        });

        expect(markdown).toContain('**FAIL**: 2 readings: 0 pass, 1 fail, 0 insufficient, 0 no-data, 1 unclassified.');
        expect(markdown).toContain(
            '| 8 | idempotent rows | postgres runtimeState.byNamespace.group-state:idempotent | ttl-within-run | ' +
                '31 min: 4200 | 12000 | 7200 | ttl 1800 s + sweep 60 s | fail |'
        );
        expect(markdown).toContain('| - | runtime_state_store namespace a\\|b | none | unclassified | - | - | - |');
        expect(markdown).toContain('- 8 idempotent rows (postgres runtimeState.byNamespace.group-state:idempotent): still rising');
    });
});
