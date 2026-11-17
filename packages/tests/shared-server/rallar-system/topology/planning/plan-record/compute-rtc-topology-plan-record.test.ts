import { describe, expect, it } from 'vitest';

import {
    computeRtcTopologyPlanRecord,
    type ComputeRtcTopologyPlanRecordInput
} from '@shared-server/rallar-system/topology/planning/plan-record/compute-rtc-topology-plan-record.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

import { EMPTY_TOPOLOGY_LAYOUT_DELTA } from '../../../../../shared/api/topology-plan/empty-topology-layout-delta.ts';
import { createGroupRef, createTopologySnapshot } from '../../rtc-topology-repository-test-fixtures.ts';

const NOW_EPOCH_MS = 10_000;

/** A path over the given members, listed from both ends as the planner publishes next hops. */
function createLayout(
    version: number,
    sessionIds: readonly string[],
    overrides: Partial<RallarOverlayTopologySnapshot> = {}
): RallarOverlayTopologySnapshot {
    const nextHopsBySessionId = Object.fromEntries(
        sessionIds.map((sessionId, index) => [
            sessionId,
            [sessionIds[index - 1], sessionIds[index + 1]].filter((hop) => hop !== undefined)
        ])
    );
    return {
        ...createTopologySnapshot(createGroupRef(), version),
        activeSessionIds: sessionIds,
        nextHopsBySessionId,
        ...overrides
    };
}

/** A presence-driven replan: change-gated, not an RTT refresh, derived incrementally. */
function createInput(
    stored: RallarOverlayTopologySnapshot | null,
    planned: RallarOverlayTopologySnapshot,
    overrides: Partial<ComputeRtcTopologyPlanRecordInput> = {}
): ComputeRtcTopologyPlanRecordInput {
    return {
        stored,
        planned,
        rttRefresh: false,
        changeGated: true,
        derivation: { method: 'incremental' },
        nowEpochMs: NOW_EPOCH_MS,
        ...overrides
    };
}

describe('computeRtcTopologyPlanRecord', () => {
    it('a first layout replaces nothing and is caused by its joiners', () => {
        const planned = createLayout(1, ['a', 'b', 'c']);
        const expected = {
            plannedAtEpochMs: NOW_EPOCH_MS,
            replaced: null,
            causes: ['join'],
            delta: { ...EMPTY_TOPOLOGY_LAYOUT_DELTA, joinedSessionCount: 3 },
            longestPathHops: 2,
            change: { kind: 'attach' }
        };

        expect(computeRtcTopologyPlanRecord(createInput(null, planned))).toEqual(expected);
        // A removed tombstone is no standing layout: the plan after it is a first layout too.
        const tombstone = createLayout(1, ['a', 'b'], { state: 'removed' });
        expect(computeRtcTopologyPlanRecord(createInput(tombstone, planned))).toEqual(expected);
    });

    it('a first layout on a group revision that is not change-gated is caused by its joiners and by config', () => {
        const planned = createLayout(1, ['a', 'b', 'c']);

        expect(computeRtcTopologyPlanRecord(createInput(null, planned, { changeGated: false })).causes).toEqual([
            'join',
            'config'
        ]);
    });

    it('names the replaced layout\'s identity and its age at the planning instant', () => {
        const stored = createLayout(3, ['a', 'b'], { updatedAtEpochMs: 4_000 });
        const planned = createLayout(4, ['a', 'b', 'c']);

        expect(computeRtcTopologyPlanRecord(createInput(stored, planned)).replaced).toEqual({
            layout: { groupRevision: 3, presenceRevision: 3, version: 3, state: 'active' },
            ageMs: 6_000
        });
    });

    it('an age is never negative when the stored layout\'s instant is ahead of this process\'s clock', () => {
        const stored = createLayout(3, ['a', 'b'], { updatedAtEpochMs: NOW_EPOCH_MS + 250 });
        const planned = createLayout(4, ['a', 'b', 'c']);

        expect(computeRtcTopologyPlanRecord(createInput(stored, planned)).replaced?.ageMs).toBe(0);
    });

    it('a join and a leave coalesced into one plan carry both causes, in canonical order', () => {
        const stored = createLayout(3, ['a', 'b']);
        const planned = createLayout(4, ['b', 'c']);

        const record = computeRtcTopologyPlanRecord(createInput(stored, planned));

        expect(record.causes).toEqual(['join', 'leave']);
        expect(record.delta).toMatchObject({ joinedSessionCount: 1, leftSessionCount: 1 });
    });

    it('an RTT refresh is caused by rtt alone when no member changed', () => {
        const stored = createLayout(3, ['a', 'b', 'c']);
        const planned = createLayout(4, ['b', 'a', 'c']);

        const record = computeRtcTopologyPlanRecord(
            createInput(stored, planned, { rttRefresh: true, changeGated: false })
        );

        expect(record.causes).toEqual(['rtt']);
        expect(record.delta).toMatchObject({ joinedSessionCount: 0, leftSessionCount: 0 });
    });

    it('a per-command group revision is caused by config', () => {
        const stored = createLayout(3, ['a', 'b']);
        const planned = createLayout(4, ['a', 'b']);

        expect(computeRtcTopologyPlanRecord(createInput(stored, planned, { changeGated: false })).causes).toEqual([
            'config'
        ]);
    });

    it('a changed degree limit or room name is caused by config', () => {
        const stored = createLayout(3, ['a', 'b']);

        const degreeLimitChanged = createLayout(4, ['a', 'b'], { degreeLimit: stored.degreeLimit + 1 });
        const nameChanged = createLayout(4, ['a', 'b'], { name: 'Renamed room' });

        expect(computeRtcTopologyPlanRecord(createInput(stored, degreeLimitChanged)).causes).toEqual(['config']);
        expect(computeRtcTopologyPlanRecord(createInput(stored, nameChanged)).causes).toEqual(['config']);
    });

    it('a plan rebuilt to root a leader is caused by leader-change and is a reshape for leader-rooting', () => {
        const stored = createLayout(3, ['a', 'b', 'c']);
        const planned = createLayout(4, ['b', 'a', 'c']);

        const record = computeRtcTopologyPlanRecord(
            createInput(stored, planned, { derivation: { method: 'rebuilt', reason: 'leader-rooting' } })
        );

        expect(record.causes).toEqual(['leader-change']);
        expect(record.change).toEqual({ kind: 'reshape', reason: 'leader-rooting' });
    });

    it('a plan rebuilt for any other reason is no leader-change', () => {
        const stored = createLayout(3, ['a', 'b', 'c']);
        const planned = createLayout(4, ['b', 'a', 'c']);

        const record = computeRtcTopologyPlanRecord(
            createInput(stored, planned, { derivation: { method: 'rebuilt', reason: 'kind-change' } })
        );

        expect(record.causes).toEqual([]);
        expect(record.change).toEqual({ kind: 'reshape', reason: 'kind-change' });
    });

    it('an incremental plan a member left is a repair', () => {
        const record = computeRtcTopologyPlanRecord(createInput(createLayout(3, ['a', 'b', 'c']), createLayout(4, ['a', 'b'])));

        expect(record.change).toEqual({ kind: 'repair' });
    });

    it('a plan that changes nothing has no cause and an empty delta', () => {
        const stored = createLayout(3, ['a', 'b', 'c']);
        const planned = createLayout(4, ['a', 'b', 'c']);

        const record = computeRtcTopologyPlanRecord(createInput(stored, planned));

        expect(record.causes).toEqual([]);
        expect(record.delta).toEqual(EMPTY_TOPOLOGY_LAYOUT_DELTA);
        expect(record.change).toBeNull();
    });
});
