import {
    describe,
    expect,
    it
} from 'vitest';

import { toGrowthVerdictMarkdown } from '../../../shared-test/rallar-bb-test/alm/growth-proof/to-growth-verdict-markdown.ts';

describe('Growth verdict document', () => {
    it('tables every reading with its class, plateau, slope, max, bound and verdict, and lists the reasons', () => {
        const markdown = toGrowthVerdictMarkdown({
            skippedLines: 1,
            verdict: {
                passed: false,
                windowStartedAtEpochMs: 1_800_000_000_000,
                workload: {
                    runner: 'failed',
                    manifestStartedAtEpochMs: 1_800_000_018_000,
                    manifestCompletedAtEpochMs: 1_800_004_740_000,
                    manifestAgents: 15,
                    eventHistoryMaxEvents: 10_000,
                    groupCurrentSnapshotCacheMaxEntries: 32,
                    apiProcesses: 3,
                    churnStarted: 30,
                    churnPassed: 29,
                    churnFailedRunIds: ['churn-004']
                },
                workloadIssues: ['the manifest runner ended failed, not passed', 'churn iterations failed: churn-004'],
                followUps: ['18 app_data_store (postgres tables.app_data_store)'],
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
                    },
                    {
                        surfaceId: 18,
                        surface: 'app_data_store',
                        reader: 'postgres tables.app_data_store',
                        growthClass: 'unbounded',
                        bound: 'none: rows expire only when read',
                        firstPlateau: { atElapsedMs: 0, value: 0 },
                        slopePerHour: 0,
                        max: 0,
                        outcome: 'unbounded-unexercised',
                        reason: 'never grew during the run'
                    }
                ]
            }
        });

        expect(markdown).toContain(
            '**FAIL**: 3 readings: 0 pass, 0 declared, 1 fail, 0 insufficient, 0 no-data, 1 unclassified, ' +
                '1 unbounded-unexercised.'
        );
        expect(markdown).toContain(
            'Workload: the manifest ran from 0.3 min to 79 min of the window (its stream runs inside it); runner failed; ' +
                'churn 29 passed, 1 failed.'
        );
        expect(markdown).toContain('- the manifest runner ended failed, not passed');
        expect(markdown).toContain('- churn iterations failed: churn-004');
        expect(markdown).toContain(
            '## Follow-ups: unbounded surfaces the workload never grew\n\n- 18 app_data_store (postgres tables.app_data_store)'
        );
        expect(markdown).toContain(
            '| 8 | idempotent rows | postgres runtimeState.byNamespace.group-state:idempotent | ttl-within-run | ' +
                '31 min: 4200 | 12000 | 7200 | ttl 1800 s + sweep 60 s | fail |'
        );
        expect(markdown).toContain('| - | runtime_state_store namespace a\\|b | none | unclassified | - | - | - |');
        expect(markdown).toContain('- 8 idempotent rows (postgres runtimeState.byNamespace.group-state:idempotent): still rising');
    });
});
