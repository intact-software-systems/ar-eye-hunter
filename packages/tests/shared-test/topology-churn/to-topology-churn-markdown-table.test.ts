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
    'appointments',
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
    'kinds attach/repair/reshape',
    'promoted kinds attach/repair/reshape',
    'rerouting kinds attach/repair/reshape',
    'reshape reasons',
    'reshapes/min',
    'rerouted per reshape min/p50/p90/max',
    'rerouted per reshape by reason p50/max',
    'causes join/leave/leader-change/config/rtt',
    'uncaused',
    'longest path hops first/last/max',
    'link-sampled plans',
    'members under k links min/p50/p90/max'
];

const CHURN: TopologyChurnPhaseReport = {
    phase: 'churn',
    durationMs: 90_250,
    joinCount: 15,
    leaveCount: 15,
    appointmentCount: 4,
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
    plansByKind: { attach: 6, repair: 2, reshape: 3 },
    promotedPlansByKind: { attach: 5, repair: 2, reshape: 2 },
    reroutingPlansByKind: { attach: 0, repair: 0, reshape: 3 },
    reshapesByReason: {
        'leader-rooting': 0,
        'delta-too-large': 1,
        'update-failed': 0,
        'invariant-violation': 0,
        'kind-change': 0,
        refinement: 2
    },
    // Three reshapes over 90 250 ms.
    reshapesPerMinute: 1.9944598337950139,
    reroutedSessionsPerReshape: { min: 1, median: 2, p90: 3, max: 3 },
    reroutedSessionsPerReshapeByReason: {
        'leader-rooting': null,
        'delta-too-large': { min: 1, median: 1, p90: 1, max: 1 },
        'update-failed': null,
        'invariant-violation': null,
        'kind-change': null,
        refinement: { min: 2, median: 2, p90: 3, max: 3 }
    },
    plansByCause: { join: 7, leave: 5, 'leader-change': 0, config: 0, rtt: 1 },
    uncausedPlanCount: 0,
    longestPathHops: { first: 2, last: 3, max: 4 },
    linkSampledPlanCount: 9,
    underLinkedMembersPerPlan: { min: 0, median: 1, p90: 2, max: 3 }
};

// A phase without plans: every rate, share, distribution and hop figure is null in the report.
const EMPTY_FORMATION: TopologyChurnPhaseReport = {
    ...CHURN,
    phase: 'formation',
    durationMs: 0,
    joinCount: 3,
    leaveCount: 0,
    appointmentCount: 0,
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
    plansByKind: { attach: 0, repair: 0, reshape: 0 },
    promotedPlansByKind: { attach: 0, repair: 0, reshape: 0 },
    reroutingPlansByKind: { attach: 0, repair: 0, reshape: 0 },
    reshapesByReason: {
        'leader-rooting': 0,
        'delta-too-large': 0,
        'update-failed': 0,
        'invariant-violation': 0,
        'kind-change': 0,
        refinement: 0
    },
    reshapesPerMinute: null,
    reroutedSessionsPerReshape: null,
    reroutedSessionsPerReshapeByReason: {
        'leader-rooting': null,
        'delta-too-large': null,
        'update-failed': null,
        'invariant-violation': null,
        'kind-change': null,
        refinement: null
    },
    plansByCause: { join: 0, leave: 0, 'leader-change': 0, config: 0, rtt: 0 },
    longestPathHops: null,
    linkSampledPlanCount: 0,
    underLinkedMembersPerPlan: null
};

const ENTRY: TopologyChurnRoomEntry = {
    replanning: 'debounced',
    memberCount: 8,
    topology: ['tree', 'mesh'],
    report: { phases: [EMPTY_FORMATION, CHURN], outsidePhasesPlanCount: 2 },
    drift: { acceptedLongestPathHops: 4, freshLongestPathHops: 3, extraHops: 1 },
    topologyConfig: { topologyKind: 'auto', degreeLimit: 4, treeMinSize: 5, meshMinSize: 16, meshParamK: 3 }
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
        expect(lines.slice(4, 6).map((line) => toCells(line)[0])).toEqual(['formation', 'churn']);
    });

    it('prints a phase with figures rounded to their unit', () => {
        expect(toCells(lines[5])).toEqual([
            'churn',
            '90.3',
            '15',
            '15',
            '4',
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
            '6 / 2 / 3',
            '5 / 2 / 2',
            '0 / 0 / 3',
            'delta-too-large: 1, refinement: 2',
            '2.0',
            '1 / 2 / 3 / 3',
            'delta-too-large: 1/1, refinement: 2/3',
            '7 / 5 / 0 / 0 / 1',
            '0',
            '2 / 3 / 4',
            '9',
            '0 / 1 / 2 / 3'
        ]);
    });

    it('prints the median and max of each reason that reshaped, in the order the reasons are declared', () => {
        const byReason: TopologyChurnPhaseReport['reroutedSessionsPerReshapeByReason'] = {
            // Listed out of order: the cell follows the declared reason order, not the object's.
            refinement: { min: 1, median: 4, p90: 6, max: 7 },
            'kind-change': null,
            'invariant-violation': null,
            'update-failed': null,
            'delta-too-large': null,
            'leader-rooting': { min: 2, median: 3, p90: 5, max: 5 }
        };
        const entry: TopologyChurnRoomEntry = {
            ...ENTRY,
            report: { phases: [{ ...CHURN, reroutedSessionsPerReshapeByReason: byReason }], outsidePhasesPlanCount: 0 }
        };
        const column = COLUMNS.indexOf('rerouted per reshape by reason p50/max');

        expect(toCells(toTopologyChurnMarkdownTable(entry).split('\n')[4])[column]).toBe(
            'leader-rooting: 3/5, refinement: 4/7'
        );
    });

    it('prints every null figure as an em dash, never null, NaN or an empty cell', () => {
        const cells = toCells(lines[4]);

        expect(cells).toEqual([
            'formation',
            '0.0',
            '3',
            '0',
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
            '0 / 0 / 0',
            '0 / 0 / 0',
            '0 / 0 / 0',
            '—',
            '—',
            '—',
            '—',
            '0 / 0 / 0 / 0 / 0',
            '0',
            '—',
            '0',
            '—'
        ]);
        expect(cells.filter((cell) => cell === '' || cell.includes('null') || cell.includes('NaN'))).toEqual([]);
    });

    it('states the plans outside every phase, the measured drift and the room\'s configuration under the table', () => {
        expect(lines.slice(6)).toEqual([
            '',
            'Plans outside every phase: 2. Drift: accepted 4 hops, fresh no-RTT plan 3 hops, extra 1.',
            'Room configuration: kind auto, tree from 5 members, mesh from 16, k = 3, degree limit 4.'
        ]);
    });
});
