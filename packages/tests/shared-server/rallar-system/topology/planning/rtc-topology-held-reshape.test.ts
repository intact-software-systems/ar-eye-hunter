import { describe, expect, it } from 'vitest';

import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { TopologyReshapePermission } from '@shared/api/topology-plan/topology-reshape-gate.ts';

import { toRtcTopologyGroupWithDirector } from '../rtc-topology-test-fixtures.ts';
import {
    computeRtcTopologyFixturePlan,
    computeRtcTopologyFixtureRebuild,
    createRtcTopologyFixtureGroup,
    isConnectedRtcTopologyFixtureLayout,
    RTC_TOPOLOGY_SIZE_SELECTED_OPTIONS,
    RTC_TOPOLOGY_TREE_OPTIONS
} from './rtc-topology-planning-fixtures.ts';

const HELD: TopologyReshapePermission = { reshape: 'held' };

describe('the planner with the reshape held', () => {
    it('a fifth member joins a star with the reshape held: the star is kept and kind-change is held', () => {
        const formed = formSizeSelected(4);

        const joined = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_SIZE_SELECTED_OPTIONS,
            group: createRtcTopologyFixtureGroup(5),
            previous: formed,
            reshape: HELD
        });

        expect(joined.snapshot.topology).toBe('star');
        expect(joined.derivation).toEqual({ method: 'incremental' });
        expect(joined.heldReshapeReasons).toEqual(['kind-change']);
        expect(isCompleteLayout(joined.snapshot)).toBe(true);
    });

    it('a held star is kept at six members and becomes a tree at seven', () => {
        // A star links every member to every other, so at seven a member would need six links past the limit of five.
        const six = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_SIZE_SELECTED_OPTIONS,
            group: createRtcTopologyFixtureGroup(6),
            previous: formSizeSelected(4),
            reshape: HELD
        });
        const seven = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_SIZE_SELECTED_OPTIONS,
            group: createRtcTopologyFixtureGroup(7),
            previous: six.snapshot,
            reshape: HELD
        });

        expect(six.snapshot.topology).toBe('star');
        expect(six.heldReshapeReasons).toEqual(['kind-change']);
        expect(seven.snapshot.topology).toBe('tree');
        expect(seven.derivation).toEqual({ method: 'rebuilt', reason: 'kind-change' });
        expect(seven.heldReshapeReasons).toEqual([]);
    });

    it('a tree grows past sixteen members with the reshape held and stays a tree', () => {
        const formed = formSizeSelected(15);

        const grown = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_SIZE_SELECTED_OPTIONS,
            group: createRtcTopologyFixtureGroup(17),
            previous: formed,
            reshape: HELD
        });

        expect(formed.topology).toBe('tree');
        expect(grown.snapshot.topology).toBe('tree');
        expect(grown.derivation).toEqual({ method: 'incremental' });
        expect(grown.heldReshapeReasons).toEqual(['kind-change']);
        expect(isConnectedRtcTopologyFixtureLayout(grown.snapshot)).toBe(true);
    });

    it('a mesh that shrinks below eleven with the reshape held stays a mesh and repairs in place', () => {
        // Twelve members keep the mesh by its hysteresis; ten fall below its exit and select a tree.
        const twelve = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_SIZE_SELECTED_OPTIONS,
            group: createRtcTopologyFixtureGroup(12),
            previous: formSizeSelected(16)
        });

        const ten = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_SIZE_SELECTED_OPTIONS,
            group: createRtcTopologyFixtureGroup(10),
            previous: twelve.snapshot,
            reshape: HELD
        });

        expect(twelve.snapshot.topology).toBe('mesh');
        expect(ten.snapshot.topology).toBe('mesh');
        expect(ten.derivation).toEqual({ method: 'incremental' });
        expect(ten.heldReshapeReasons).toEqual(['kind-change']);
        expect(isConnectedRtcTopologyFixtureLayout(ten.snapshot)).toBe(true);
    });

    it('an appointed leader that is too deep keeps the tree with the reshape held and leader-rooting is held', () => {
        // Allowed, peer-1 appointed in this fifteen-member tree is rebuilt for leader rooting.
        const leaderless = createRtcTopologyFixtureGroup(15);
        const formed = computeRtcTopologyFixturePlan({ options: RTC_TOPOLOGY_TREE_OPTIONS, group: leaderless, previous: undefined });
        const appointed = toRtcTopologyGroupWithDirector(leaderless, 'peer-1');

        const allowed = computeRtcTopologyFixturePlan({ options: RTC_TOPOLOGY_TREE_OPTIONS, group: appointed, previous: formed.snapshot });
        const held = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_TREE_OPTIONS,
            group: appointed,
            previous: formed.snapshot,
            reshape: HELD
        });

        expect(allowed.derivation).toEqual({ method: 'rebuilt', reason: 'leader-rooting' });
        expect(held.changed).toBe(false);
        expect(held.derivation).toEqual({ method: 'incremental' });
        expect(held.heldReshapeReasons).toEqual(['leader-rooting']);
    });

    it('a leader that joins with the reshape held is attached and leader-rooting is held', () => {
        const rooted = computeRtcTopologyFixtureRebuild('leader-rooting');

        const held = computeRtcTopologyFixturePlan({ ...rooted.replanInput, reshape: HELD });

        expect(held.derivation).toEqual({ method: 'incremental' });
        expect(held.heldReshapeReasons).toEqual(['leader-rooting']);
        expect(readSessionsThatLostANextHop(rooted.previous, held.snapshot)).toEqual([]);
        expect(isConnectedRtcTopologyFixtureLayout(held.snapshot)).toBe(true);
    });

    it('more than a quarter of a mesh changes with the reshape held and the room is evolved in place', () => {
        const rebuilt = computeRtcTopologyFixtureRebuild('delta-too-large');

        const held = computeRtcTopologyFixturePlan({ ...rebuilt.replanInput, reshape: HELD });

        expect(held.derivation).toEqual({ method: 'incremental' });
        expect(held.heldReshapeReasons).toEqual([]);
        expect(isConnectedRtcTopologyFixtureLayout(held.snapshot)).toBe(true);
    });

    it('an RTT refresh with the reshape held computes no refinement', () => {
        const refined = computeRtcTopologyFixtureRebuild('refinement');

        const held = computeRtcTopologyFixturePlan({ ...refined.replanInput, reshape: HELD });

        expect(refined.replanInput.planningIntent).toBe('full-rebuild');
        expect(held.changed).toBe(false);
        expect(held.snapshot.nextHopsBySessionId).toEqual(refined.previous.nextHopsBySessionId);
        expect(held.heldReshapeReasons).toEqual([]);
    });

    it('an in-place update that fails with the reshape held rebuilds with the kind a fresh plan selects', () => {
        const failed = computeRtcTopologyFixtureRebuild('update-failed');

        const held = computeRtcTopologyFixturePlan({ ...failed.replanInput, reshape: HELD });

        expect(held.derivation).toEqual({ method: 'rebuilt', reason: 'update-failed' });
        expect(held.heldReshapeReasons).toEqual([]);
        expect(held.planningObservation.incrementalFallbackReasons).toEqual(['update-failed']);
    });

    it('a held plan whose in-place update fails records its fallback and its hysteresis hold once', () => {
        // Thirteen members keep the mesh by its hysteresis; under a limit of two the evolved mesh cannot stand.
        const formed = formSizeSelected(16);
        const options = { ...RTC_TOPOLOGY_SIZE_SELECTED_OPTIONS, degreeLimit: 2, rttReportingDegreeLimit: 2 };

        const held = computeRtcTopologyFixturePlan({ options, group: createRtcTopologyFixtureGroup(13), previous: formed, reshape: HELD });

        expect(formed.topology).toBe('mesh');
        expect(held.snapshot.topology).toBe('mesh');
        expect(held.derivation).toMatchObject({ method: 'rebuilt' });
        expect(held.planningObservation.hysteresisHoldCount).toBe(1);
        expect(held.planningObservation.incrementalFallbackReasons).toHaveLength(1);
    });

    it('an evolution the validator rejects with the kind held is rebuilt into the kind a fresh plan selects', () => {
        // The six-member tree has a hub of more than two links; under a limit of two and a mesh from six members, the
        // held tree's evolution is rejected, and the fresh plan selects a mesh.
        const formed = formSizeSelected(6);
        const options = { ...RTC_TOPOLOGY_SIZE_SELECTED_OPTIONS, degreeLimit: 2, rttReportingDegreeLimit: 2, meshMinSize: 6 };

        const held = computeRtcTopologyFixturePlan({ options, group: createRtcTopologyFixtureGroup(6), previous: formed, reshape: HELD });

        expect(formed.topology).toBe('tree');
        expect(held.snapshot.topology).toBe('mesh');
        expect(held.derivation).toEqual({ method: 'rebuilt', reason: 'kind-change' });
        expect(held.heldReshapeReasons).toEqual([]);
    });

    it('with leader-rooting wanted and the reshape allowed, a join in the same plan still re-roots', () => {
        const formed = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_TREE_OPTIONS,
            group: createRtcTopologyFixtureGroup(15),
            previous: undefined
        });
        const appointedWithJoiner = toRtcTopologyGroupWithDirector(createRtcTopologyFixtureGroup(16), 'peer-1');

        const unwanted = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_TREE_OPTIONS,
            group: appointedWithJoiner,
            previous: formed.snapshot
        });
        const wanted = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_TREE_OPTIONS,
            group: appointedWithJoiner,
            previous: formed.snapshot,
            reshape: { reshape: 'allowed', wantedReasons: ['leader-rooting'] }
        });

        expect(unwanted.derivation).toEqual({ method: 'incremental' });
        expect(wanted.derivation).toEqual({ method: 'rebuilt', reason: 'leader-rooting' });
        expect(wanted.heldReshapeReasons).toEqual([]);
    });

    it('an explicit topology kind is not held', () => {
        const formed = formSizeSelected(4);

        const configured = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_TREE_OPTIONS,
            group: createRtcTopologyFixtureGroup(4),
            previous: formed,
            reshape: HELD
        });

        expect(formed.topology).toBe('star');
        expect(configured.snapshot.topology).toBe('tree');
        expect(configured.derivation).toEqual({ method: 'rebuilt', reason: 'kind-change' });
        expect(configured.heldReshapeReasons).toEqual([]);
    });
});

function formSizeSelected(memberCount: number): RallarOverlayTopologySnapshot {
    return computeRtcTopologyFixturePlan({
        options: RTC_TOPOLOGY_SIZE_SELECTED_OPTIONS,
        group: createRtcTopologyFixtureGroup(memberCount),
        previous: undefined
    }).snapshot;
}

function isCompleteLayout(snapshot: RallarOverlayTopologySnapshot): boolean {
    return snapshot.activeSessionIds.every((sessionId) =>
        snapshot.activeSessionIds.every((other) => other === sessionId || (snapshot.nextHopsBySessionId[sessionId] ?? []).includes(other))
    );
}

/** The previous members still in the room that lost a next hop they held. */
function readSessionsThatLostANextHop(
    previous: RallarOverlayTopologySnapshot,
    planned: RallarOverlayTopologySnapshot
): readonly string[] {
    return previous.activeSessionIds.filter((sessionId) =>
        planned.activeSessionIds.includes(sessionId) &&
        (previous.nextHopsBySessionId[sessionId] ?? []).some((nextHop) => !(planned.nextHopsBySessionId[sessionId] ?? []).includes(nextHop))
    );
}
