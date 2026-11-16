import type { TopologyChurnPhaseReport } from '@shared-test/black-box-runner/topology-churn/compute-topology-churn-report.ts';
import {
    toTopologyChurnMarkdownTable,
    type TopologyChurnRoomEntry
} from '@shared-test/black-box-runner/topology-churn/to-topology-churn-markdown-table.ts';
import { describe, expect, it } from 'vitest';

const COLUMNS = [
    'phase',
    'duration s',
    'joins',
    'leaves',
    'plans',
    'plans/min',
    'promoted',
    'promotions/min',
    'promotion lag ms min/p50/p90/max',
    'inside overlap',
    'inside overlap share',
    'identity-only',
    'changed sessions min/p50/p90/max',
    'rerouted sessions min/p50/p90/max',
    'joiners min/p50/p90/max',
    'rerouting membership plans',
    'rerouting membership share',
    'max joiner edges',
    'degree limit',
    'causes join/leave/leader-change/config/rtt',
    'uncaused',
    'longest path hops first/last/max'
];

const CHURN: TopologyChurnPhaseReport = {
    phase: 'churn',
    durationMs: 90_250,
    joinCount: 15,
    leaveCount: 15,
    planCount: 12,
    plansPerMinute: 7.977839335180055,
    promotedPlanCount: 10,
    promotionsPerMinute: 6.648199445983379,
    promotionLagMs: { min: 120, median: 480, p90: 7_600, max: 7_900 },
    insideOverlapPlanCount: 3,
    insideOverlapShare: 0.25,
    identityOnlyPlanCount: 1,
    changedSessionsPerPlan: { min: 1, median: 2, p90: 4, max: 5 },
    reroutedSessionsPerPlan: { min: 0, median: 1, p90: 2, max: 3 },
    joinersPerPlan: { min: 0, median: 1, p90: 1, max: 2 },
    reroutingMembershipPlanCount: 4,
    reroutingMembershipPlanShare: 0.36363636363636365,
    maxJoinerEdgesPerSession: 2,
    degreeLimit: 3,
    plansByCause: { join: 7, leave: 5, 'leader-change': 0, config: 0, rtt: 1 },
    uncausedPlanCount: 0,
    longestPathHops: { first: 2, last: 3, max: 4 }
};

// A phase without plans: every rate, share, distribution and hop figure is null in the report.
const EMPTY_FORMATION: TopologyChurnPhaseReport = {
    ...CHURN,
    phase: 'formation',
    durationMs: 0,
    joinCount: 3,
    leaveCount: 0,
    planCount: 0,
    plansPerMinute: null,
    promotedPlanCount: 0,
    promotionsPerMinute: null,
    promotionLagMs: null,
    insideOverlapPlanCount: 0,
    insideOverlapShare: null,
    identityOnlyPlanCount: 0,
    changedSessionsPerPlan: null,
    reroutedSessionsPerPlan: null,
    joinersPerPlan: null,
    reroutingMembershipPlanCount: 0,
    reroutingMembershipPlanShare: null,
    maxJoinerEdgesPerSession: 0,
    degreeLimit: null,
    plansByCause: { join: 0, leave: 0, 'leader-change': 0, config: 0, rtt: 0 },
    longestPathHops: null
};

const ENTRY: TopologyChurnRoomEntry = {
    replanning: 'debounced',
    memberCount: 8,
    topology: ['tree', 'mesh'],
    report: { phases: [EMPTY_FORMATION, CHURN] },
    drift: null
};

function toCells(line: string): string[] {
    return line.split('|').slice(1, -1).map((cell) => cell.trim());
}

describe('toTopologyChurnMarkdownTable', () => {
    const lines = toTopologyChurnMarkdownTable(ENTRY).split('\n');

    it('titles the table with the mode, the size and the kinds the room used in order', () => {
        expect(lines[0]).toBe('### debounced, 8 members, tree → mesh');
        expect(lines[1]).toBe('');
    });

    it('has one column per figure and one row per phase', () => {
        expect(toCells(lines[2])).toEqual(COLUMNS);
        expect(toCells(lines[3])).toEqual(COLUMNS.map(() => '---'));
        expect(lines.slice(4).map((line) => toCells(line)[0])).toEqual(['formation', 'churn']);
    });

    it('prints a phase with figures rounded to their unit', () => {
        expect(toCells(lines[5])).toEqual([
            'churn',
            '90.3',
            '15',
            '15',
            '12',
            '8.0',
            '10',
            '6.6',
            '120 / 480 / 7600 / 7900',
            '3',
            '0.25',
            '1',
            '1 / 2 / 4 / 5',
            '0 / 1 / 2 / 3',
            '0 / 1 / 1 / 2',
            '4',
            '0.36',
            '2',
            '3',
            '7 / 5 / 0 / 0 / 1',
            '0',
            '2 / 3 / 4'
        ]);
    });

    it('prints every null figure as an em dash, never null, NaN or an empty cell', () => {
        const cells = toCells(lines[4]);

        expect(cells).toEqual([
            'formation',
            '0.0',
            '3',
            '0',
            '0',
            '—',
            '0',
            '—',
            '—',
            '0',
            '—',
            '0',
            '—',
            '—',
            '—',
            '0',
            '—',
            '0',
            '—',
            '0 / 0 / 0 / 0 / 0',
            '0',
            '—'
        ]);
        expect(cells.filter((cell) => cell === '' || cell.includes('null') || cell.includes('NaN'))).toEqual([]);
    });
});
