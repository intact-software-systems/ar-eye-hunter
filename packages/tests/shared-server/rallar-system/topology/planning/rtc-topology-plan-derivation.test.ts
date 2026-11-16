import { describe, expect, it } from 'vitest';

import { createRtcTopologyMemberIds } from '../rtc-topology-test-fixtures.ts';
import {
    computeRtcTopologyFixtureLeave,
    computeRtcTopologyFixturePlan,
    computeRtcTopologyFixtureRebuild,
    createRtcTopologyFixtureGroup,
    createRtcTopologyFixtureRttMeasurements,
    RTC_TOPOLOGY_MESH_OPTIONS,
    RTC_TOPOLOGY_STAR_OPTIONS,
    RTC_TOPOLOGY_TREE_OPTIONS
} from './rtc-topology-planning-fixtures.ts';

describe('the derivation of a planned layout', () => {
    it('a first layout is established', () => {
        // Nothing was accepted before, so there is no layout to evolve or to rebuild.
        const formed = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_TREE_OPTIONS,
            group: createRtcTopologyFixtureGroup(6),
            previous: undefined
        });

        expect(formed.derivation).toEqual({ method: 'established' });
    });

    it('a join on a tree is incremental', () => {
        // One join on a leaderless tree is within the delta budget and attaches without replacing an edge.
        const formed = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_TREE_OPTIONS,
            group: createRtcTopologyFixtureGroup(6),
            previous: undefined
        });

        const joined = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_TREE_OPTIONS,
            group: createRtcTopologyFixtureGroup(7),
            previous: formed.snapshot
        });

        expect(joined.derivation).toEqual({ method: 'incremental' });
    });

    it('a leaf\'s leave from a tree is incremental', () => {
        // A leaf holds one edge, so its leave removes that edge and leaves a valid tree of the rest.
        const left = computeRtcTopologyFixtureLeave(RTC_TOPOLOGY_TREE_OPTIONS, 8, (nextHopCount) => nextHopCount === 1);

        expect(left.planned.derivation).toEqual({ method: 'incremental' });
    });

    it('a relay\'s leave from a tree is incremental', () => {
        // A relay's leave is one change within the delta budget; the tree update reconnects its children validly.
        const left = computeRtcTopologyFixtureLeave(RTC_TOPOLOGY_TREE_OPTIONS, 8, (nextHopCount) => nextHopCount > 1);

        expect(left.planned.derivation).toEqual({ method: 'incremental' });
    });

    it('a join into a mesh is incremental', () => {
        // One join on an eight-member mesh is within the delta budget of two, and the mesh insert keeps it valid.
        const formed = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_MESH_OPTIONS,
            group: createRtcTopologyFixtureGroup(8),
            previous: undefined
        });

        const joined = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_MESH_OPTIONS,
            group: createRtcTopologyFixtureGroup(9),
            previous: formed.snapshot
        });

        expect(joined.derivation).toEqual({ method: 'incremental' });
    });

    it('a join into a complete graph is incremental', () => {
        // A star of the same kind is a complete graph, which follows the membership alone.
        const formed = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_STAR_OPTIONS,
            group: createRtcTopologyFixtureGroup(3),
            previous: undefined
        });

        const joined = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_STAR_OPTIONS,
            group: createRtcTopologyFixtureGroup(4),
            previous: formed.snapshot
        });

        expect(joined.derivation).toEqual({ method: 'incremental' });
    });

    it('a room that grows from a complete graph into a tree is rebuilt for its change of kind', () => {
        const grown = computeRtcTopologyFixtureRebuild('kind-change');

        expect(grown.previous.topology).toBe('star');
        expect(grown.planned.snapshot.topology).toBe('tree');
        expect(grown.planned.derivation).toEqual({ method: 'rebuilt', reason: 'kind-change' });
    });

    it('a leader that joins a tree is rebuilt for leader rooting', () => {
        const joined = computeRtcTopologyFixtureRebuild('leader-rooting');

        expect(joined.planned.derivation).toEqual({ method: 'rebuilt', reason: 'leader-rooting' });
    });

    it('more than a quarter of a mesh changing at once is rebuilt because the delta is too large', () => {
        const joined = computeRtcTopologyFixtureRebuild('delta-too-large');

        expect(joined.planned.derivation).toEqual({ method: 'rebuilt', reason: 'delta-too-large' });
    });

    it('a join that finds no session with a free link is rebuilt because the update failed', () => {
        const joined = computeRtcTopologyFixtureRebuild('update-failed');

        expect(joined.planned.derivation).toEqual({ method: 'rebuilt', reason: 'update-failed' });
    });

    it('an evolved graph that breaks the degree limit is rebuilt for the invariant', () => {
        const replanned = computeRtcTopologyFixtureRebuild('invariant-violation');

        expect(Math.max(...Object.values(replanned.previous.nextHopsBySessionId).map((nextHops) => nextHops.length)))
            .toBeGreaterThan(2);
        expect(replanned.planned.derivation).toEqual({ method: 'rebuilt', reason: 'invariant-violation' });
    });

    it('an RTT refresh that keeps the tree is incremental', () => {
        // Every link measures 2 ms, so no rebuild can shorten the slowest path by the required 10 ms.
        const formed = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_TREE_OPTIONS,
            group: createRtcTopologyFixtureGroup(6),
            previous: undefined
        });

        const refreshed = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_TREE_OPTIONS,
            group: createRtcTopologyFixtureGroup(6),
            previous: formed.snapshot,
            planningIntent: 'full-rebuild',
            rttMeasurements: createRtcTopologyFixtureRttMeasurements(createRtcTopologyMemberIds(6), () => 2)
        });

        expect(refreshed.snapshot.nextHopsBySessionId).toEqual(formed.snapshot.nextHopsBySessionId);
        expect(refreshed.derivation).toEqual({ method: 'incremental' });
    });

    it('an RTT refresh whose rebuild is a quarter and ten milliseconds better is rebuilt as a refinement', () => {
        const refreshed = computeRtcTopologyFixtureRebuild('refinement');

        expect(refreshed.planned.snapshot.nextHopsBySessionId).not.toEqual(refreshed.previous.nextHopsBySessionId);
        expect(refreshed.planned.derivation).toEqual({ method: 'rebuilt', reason: 'refinement' });
    });

    it('an RTT refresh of a mesh is rebuilt as a refinement', () => {
        // Only a tree weighs keeping its accepted layout against an RTT rebuild; a mesh refresh always rebuilds.
        const formed = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_MESH_OPTIONS,
            group: createRtcTopologyFixtureGroup(8),
            previous: undefined
        });

        const refreshed = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_MESH_OPTIONS,
            group: createRtcTopologyFixtureGroup(8),
            previous: formed.snapshot,
            planningIntent: 'full-rebuild',
            rttMeasurements: createRtcTopologyFixtureRttMeasurements(createRtcTopologyMemberIds(8), () => 2)
        });

        expect(refreshed.derivation).toEqual({ method: 'rebuilt', reason: 'refinement' });
    });

    it('a full rebuild of a same-kind tree with no RTT measurement is rebuilt as a refinement', () => {
        // A full rebuild never evolves the accepted layout, and with nothing measured there is no RTT gate to keep it.
        const formed = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_TREE_OPTIONS,
            group: createRtcTopologyFixtureGroup(6),
            previous: undefined
        });

        const rebuilt = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_TREE_OPTIONS,
            group: createRtcTopologyFixtureGroup(6),
            previous: formed.snapshot,
            planningIntent: 'full-rebuild'
        });

        expect(rebuilt.derivation).toEqual({ method: 'rebuilt', reason: 'refinement' });
    });

    it('a membership change that falls back while RTT measurements exist is rebuilt with the evolution\'s reason', () => {
        // Three joins exceed the eight-member mesh's delta budget of two; the measured rebuild keeps the fallback reason.
        const formed = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_MESH_OPTIONS,
            group: createRtcTopologyFixtureGroup(8),
            previous: undefined
        });

        const joined = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_MESH_OPTIONS,
            group: createRtcTopologyFixtureGroup(11),
            previous: formed.snapshot,
            rttMeasurements: createRtcTopologyFixtureRttMeasurements(createRtcTopologyMemberIds(11), () => 20)
        });

        expect(joined.derivation).toEqual({ method: 'rebuilt', reason: 'delta-too-large' });
    });
});
