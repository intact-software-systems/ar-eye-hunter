import { describe, expect, it } from 'vitest';

import { computeRtcTopologyPlan, type ComputedRtcTopologyPlan } from '@shared-server/rallar-system/topology/planning/rtc-topology-planner.ts';
import type {
    RallarRtcTopologyServiceOptions,
    RtcTopologyPlanningIntent
} from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

import {
    createRtcTopologyGroupSnapshot,
    createRtcTopologyMemberIds,
    createRtcTopologyRttMeasurement,
    toRtcTopologyGroupWithDirector
} from '../rtc-topology-test-fixtures.ts';

const TREE_OPTIONS: RallarRtcTopologyServiceOptions = { topologyKind: 'tree', degreeLimit: 5, rttReportingDegreeLimit: 5 };
const MESH_OPTIONS: RallarRtcTopologyServiceOptions = { topologyKind: 'mesh', degreeLimit: 5, rttReportingDegreeLimit: 5 };
const STAR_OPTIONS: RallarRtcTopologyServiceOptions = { topologyKind: 'star', degreeLimit: 5, rttReportingDegreeLimit: 5 };
const SIZE_SELECTED_OPTIONS: RallarRtcTopologyServiceOptions = { degreeLimit: 5, rttReportingDegreeLimit: 5 };

describe('the derivation of a planned layout', () => {
    it('a first layout is established', () => {
        // Nothing was accepted before, so there is no layout to evolve or to rebuild.
        const formed = plan({ options: TREE_OPTIONS, group: createGroup(6), previous: undefined });

        expect(formed.derivation).toEqual({ method: 'established' });
    });

    it('a join on a tree is incremental', () => {
        // One join on a leaderless tree is within the delta budget and attaches without replacing an edge.
        const formed = plan({ options: TREE_OPTIONS, group: createGroup(6), previous: undefined });

        const joined = plan({ options: TREE_OPTIONS, group: createGroup(7), previous: formed.snapshot });

        expect(joined.derivation).toEqual({ method: 'incremental' });
    });

    it('a leaf\'s leave from a tree is incremental', () => {
        // A leaf holds one edge, so its leave removes that edge and leaves a valid tree of the rest.
        const memberSessionIds = createRtcTopologyMemberIds(8);
        const formed = plan({ options: TREE_OPTIONS, group: createGroup(8), previous: undefined });
        const leafSessionId = findSessionId(formed.snapshot, (nextHopCount) => nextHopCount === 1);

        const left = plan({
            options: TREE_OPTIONS,
            group: createGroupOf(memberSessionIds.filter((sessionId) => sessionId !== leafSessionId)),
            previous: formed.snapshot
        });

        expect(left.derivation).toEqual({ method: 'incremental' });
    });

    it('a relay\'s leave from a tree is incremental', () => {
        // A relay's leave is one change within the delta budget; the tree update reconnects its children validly.
        const memberSessionIds = createRtcTopologyMemberIds(8);
        const formed = plan({ options: TREE_OPTIONS, group: createGroup(8), previous: undefined });
        const relaySessionId = findSessionId(formed.snapshot, (nextHopCount) => nextHopCount > 1);

        const left = plan({
            options: TREE_OPTIONS,
            group: createGroupOf(memberSessionIds.filter((sessionId) => sessionId !== relaySessionId)),
            previous: formed.snapshot
        });

        expect(left.derivation).toEqual({ method: 'incremental' });
    });

    it('a join into a mesh is incremental', () => {
        // One join on an eight-member mesh is within the delta budget of two, and the mesh insert keeps it valid.
        const formed = plan({ options: MESH_OPTIONS, group: createGroup(8), previous: undefined });

        const joined = plan({ options: MESH_OPTIONS, group: createGroup(9), previous: formed.snapshot });

        expect(joined.derivation).toEqual({ method: 'incremental' });
    });

    it('a join into a complete graph is incremental', () => {
        // A star of the same kind is a complete graph, which follows the membership alone.
        const formed = plan({ options: STAR_OPTIONS, group: createGroup(3), previous: undefined });

        const joined = plan({ options: STAR_OPTIONS, group: createGroup(4), previous: formed.snapshot });

        expect(joined.derivation).toEqual({ method: 'incremental' });
    });

    it('a room that grows from a complete graph into a tree is rebuilt for its change of kind', () => {
        // Four members are below the default tree entry size of five; the fifth member selects a tree.
        const formed = plan({ options: SIZE_SELECTED_OPTIONS, group: createGroup(4), previous: undefined });
        expect(formed.snapshot.topology).toBe('star');

        const grown = plan({ options: SIZE_SELECTED_OPTIONS, group: createGroup(5), previous: formed.snapshot });

        expect(grown.snapshot.topology).toBe('tree');
        expect(grown.derivation).toEqual({ method: 'rebuilt', reason: 'kind-change' });
    });

    it('a leader that joins a tree is rebuilt for leader rooting', () => {
        // A tree evolves only around a leader it already holds; a joining leader must root a new tree.
        const formed = plan({ options: TREE_OPTIONS, group: createGroup(6), previous: undefined });

        const joined = plan({
            options: TREE_OPTIONS,
            group: toRtcTopologyGroupWithDirector(createGroup(7), 'peer-7'),
            previous: formed.snapshot
        });

        expect(joined.derivation).toEqual({ method: 'rebuilt', reason: 'leader-rooting' });
    });

    it('more than a quarter of a mesh changing at once is rebuilt because the delta is too large', () => {
        // An eight-member mesh evolves at most max(2, ceil(8 / 4)) = 2 changes at once; three joins exceed it.
        const formed = plan({ options: MESH_OPTIONS, group: createGroup(8), previous: undefined });

        const joined = plan({ options: MESH_OPTIONS, group: createGroup(11), previous: formed.snapshot });

        expect(joined.derivation).toEqual({ method: 'rebuilt', reason: 'delta-too-large' });
    });

    it('a join that finds no session with a free link is rebuilt because the update failed', () => {
        // Under a degree limit of one, the leader-led pair has no session left with a free link, so the
        // leader-first attachment of the third member fails before any graph is validated.
        const options = { ...TREE_OPTIONS, degreeLimit: 1, rttReportingDegreeLimit: 1 };
        const formed = plan({ options, group: createLedGroup(2), previous: undefined });

        const joined = plan({ options, group: createLedGroup(3), previous: formed.snapshot });

        expect(joined.derivation).toEqual({ method: 'rebuilt', reason: 'update-failed' });
    });

    it('an evolved graph that breaks the degree limit is rebuilt for the invariant', () => {
        // The six-member tree formed under a degree limit of five has a hub of more than two links; replanned
        // at unchanged membership under a limit of two, the evolved graph is that tree, which the validator rejects.
        const formed = plan({ options: TREE_OPTIONS, group: createGroup(6), previous: undefined });
        expect(Math.max(...Object.values(formed.snapshot.nextHopsBySessionId).map((nextHops) => nextHops.length)))
            .toBeGreaterThan(2);

        const replanned = plan({
            options: { ...TREE_OPTIONS, degreeLimit: 2, rttReportingDegreeLimit: 2 },
            group: createGroup(6),
            previous: formed.snapshot
        });

        expect(replanned.derivation).toEqual({ method: 'rebuilt', reason: 'invariant-violation' });
    });

    it('an RTT refresh that keeps the tree is incremental', () => {
        // Every link measures 2 ms, so no rebuild can shorten the slowest path by the required 10 ms.
        const formed = plan({ options: TREE_OPTIONS, group: createGroup(6), previous: undefined });

        const refreshed = plan({
            options: TREE_OPTIONS,
            group: createGroup(6),
            previous: formed.snapshot,
            planningIntent: 'full-rebuild',
            rttMeasurements: createRttMeasurements(createRtcTopologyMemberIds(6), () => 2)
        });

        expect(refreshed.snapshot.nextHopsBySessionId).toEqual(formed.snapshot.nextHopsBySessionId);
        expect(refreshed.derivation).toEqual({ method: 'incremental' });
    });

    it('an RTT refresh whose rebuild is a quarter and ten milliseconds better is rebuilt as a refinement', () => {
        // The formed tree's links measure 200 ms and every other link 10 ms: the rebuild's slowest path is at
        // least 150 ms shorter, past both the quarter and the 10 ms gates.
        const formed = plan({ options: TREE_OPTIONS, group: createGroup(6), previous: undefined });
        const formedEdges = toEdgeSet(formed.snapshot.nextHopsBySessionId);

        const refreshed = plan({
            options: TREE_OPTIONS,
            group: createGroup(6),
            previous: formed.snapshot,
            planningIntent: 'full-rebuild',
            rttMeasurements: createRttMeasurements(
                createRtcTopologyMemberIds(6),
                (from, to) => formedEdges.has(toEdge(from, to)) ? 200 : 10
            )
        });

        expect(refreshed.snapshot.nextHopsBySessionId).not.toEqual(formed.snapshot.nextHopsBySessionId);
        expect(refreshed.derivation).toEqual({ method: 'rebuilt', reason: 'refinement' });
    });

    it('an RTT refresh of a mesh is rebuilt as a refinement', () => {
        // Only a tree weighs keeping its accepted layout against an RTT rebuild; a mesh refresh always rebuilds.
        const formed = plan({ options: MESH_OPTIONS, group: createGroup(8), previous: undefined });

        const refreshed = plan({
            options: MESH_OPTIONS,
            group: createGroup(8),
            previous: formed.snapshot,
            planningIntent: 'full-rebuild',
            rttMeasurements: createRttMeasurements(createRtcTopologyMemberIds(8), () => 2)
        });

        expect(refreshed.derivation).toEqual({ method: 'rebuilt', reason: 'refinement' });
    });
});

interface PlanInput {
    readonly options: RallarRtcTopologyServiceOptions;
    readonly group: GroupSnapshot;
    readonly previous: RallarOverlayTopologySnapshot | undefined;
    readonly planningIntent?: RtcTopologyPlanningIntent;
    readonly rttMeasurements?: readonly RttMeasurementInfo[];
}

function plan(input: PlanInput): ComputedRtcTopologyPlan {
    return computeRtcTopologyPlan(input.options, {
        group: input.group,
        rttMeasurements: input.rttMeasurements ?? [],
        previous: input.previous,
        updateOptions: { planningIntent: input.planningIntent ?? 'membership-delta' },
        nowEpochMs: 100
    });
}

function createGroup(memberCount: number): GroupSnapshot {
    return createGroupOf(createRtcTopologyMemberIds(memberCount));
}

function createLedGroup(memberCount: number): GroupSnapshot {
    return toRtcTopologyGroupWithDirector(createGroup(memberCount), 'peer-1');
}

function createGroupOf(memberSessionIds: readonly string[]): GroupSnapshot {
    return createRtcTopologyGroupSnapshot('derivation-group', memberSessionIds);
}

function findSessionId(
    snapshot: RallarOverlayTopologySnapshot,
    matches: (nextHopCount: number) => boolean
): string {
    const sessionId = snapshot.activeSessionIds.find((candidate) => matches(snapshot.nextHopsBySessionId[candidate]?.length ?? 0));
    if (sessionId === undefined) {
        throw new Error('The formed tree has no session of the wanted shape');
    }
    return sessionId;
}

function createRttMeasurements(
    sessionIds: readonly string[],
    toRttMs: (from: string, to: string) => number
): readonly RttMeasurementInfo[] {
    return sessionIds.flatMap((sessionIdFrom, fromIndex) =>
        sessionIds.slice(fromIndex + 1).map((sessionIdTo, toIndex) =>
            createRtcTopologyRttMeasurement({
                sessionIdFrom,
                sessionIdTo,
                rttMs: toRttMs(sessionIdFrom, sessionIdTo),
                version: fromIndex * sessionIds.length + toIndex + 1
            })
        )
    );
}

function toEdgeSet(nextHopsBySessionId: Readonly<Record<string, readonly string[]>>): Set<string> {
    return new Set(
        Object.entries(nextHopsBySessionId).flatMap(([from, nextHops]) => nextHops.map((to) => toEdge(from, to)))
    );
}

function toEdge(left: string, right: string): string {
    return left < right ? `${left}|${right}` : `${right}|${left}`;
}
