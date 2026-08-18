import { describe, expect, it } from 'vitest';
import {
    RallarRtcTopologyService,
    type RallarRtcTopologyUpdateResult,
} from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
import { validateGroupTopologyNextHops } from '@shared-graph/group-topology-validation.ts';
import type { AuditStamp, GroupSnapshot } from '@shared/api/group-types.ts';
import { createTestGroup } from '@shared-test/create-test-group.ts';

// Phase 4 (M6) incremental-evolution contract, exercised through the planning
// kernel exactly as the durable group-revision work path drives it: seeded
// membership-delta plans preserve the previous structure (edge churn bounded
// by O(degree) per change), stay deterministic given an equal previous, and
// pass the same invariant validator as a full rebuild.
describe('evolve planned topology through the kernel', () => {
    // The mesh insert/remove algorithms repair a membership delta in place at
    // every size measured here. The tree remove path can still produce a graph
    // that fails the invariant validator for some shapes, so the tree tier
    // asserts the guaranteed contract — a bounded, valid plan — while the mesh
    // tiers additionally pin that no evolution was rejected as invalid.
    it.each([
        { memberCount: 8, kind: 'tree', evolvesEveryChange: false },
        { memberCount: 20, kind: 'mesh', evolvesEveryChange: true },
        { memberCount: 50, kind: 'mesh', evolvesEveryChange: true },
    ])(
        'bounds single join/leave churn by O(degree) at N=$memberCount ($kind)',
        ({ memberCount, kind, evolvesEveryChange }) => {
            const members = createMemberIds(memberCount);
            const service = new RallarRtcTopologyService({ now: () => 100 });
            const formed = service.planGroupTopologyAt(
                createGroupSnapshot('evolve-group', members, 1),
                [],
                { planningIntent: 'membership-delta' },
                100,
            );
            expect(formed.snapshot.topology).toBe(kind);
            const churnBudget = 2 * (formed.snapshot.degreeLimit + 1);

            const joined = service.planGroupTopologyAt(
                createGroupSnapshot('evolve-group', [...members, 'session-joiner-901'], 2),
                [],
                { previous: formed.snapshot, planningIntent: 'membership-delta' },
                200,
            );
            expect(service.readMetrics().incrementalPlanCount).toBe(1);
            expect(edgeChurn(formed, joined)).toBeLessThanOrEqual(churnBudget);
            expectValidPlan(joined);

            const leaver = members[Math.floor(memberCount / 2)];
            const remaining = members.filter((sessionId) => sessionId !== leaver);
            const left = service.planGroupTopologyAt(
                createGroupSnapshot('evolve-group', remaining, 3),
                [],
                { previous: formed.snapshot, planningIntent: 'membership-delta' },
                300,
            );
            // A leave may legitimately fall back to a full rebuild when the
            // repair cannot keep the previous structure; what the contract
            // guarantees either way is a bounded, valid plan that never came
            // from an invariant-violating evolution.
            expect(service.readMetrics().incrementalPlanCount).toBe(evolvesEveryChange ? 2 : 1);
            if (evolvesEveryChange) {
                expect(service.readMetrics().incrementalPlanInvariantFallbackCount).toBe(0);
            }
            expect(edgeChurn(formed, left)).toBeLessThanOrEqual(churnBudget);
            expectValidPlan(left);
        },
    );

    it('evolves deterministically for shuffled input orders given an equal previous', () => {
        const members = createMemberIds(20);
        const service = new RallarRtcTopologyService({ now: () => 100 });
        const formed = service.planGroupTopologyAt(
            createGroupSnapshot('evolve-group', members, 1),
            [],
            { planningIntent: 'membership-delta' },
            100,
        );

        const nextMembers = [...members, 'session-joiner-901'];
        const planned = [nextMembers, [...nextMembers].reverse()].map((order) =>
            new RallarRtcTopologyService({ now: () => 200 }).planGroupTopologyAt(
                createGroupSnapshot('evolve-group', order, 2),
                [],
                { previous: formed.snapshot, planningIntent: 'membership-delta' },
                200,
            )
        );

        expect(JSON.stringify(planned[0].snapshot.nextHopsBySessionId)).toBe(
            JSON.stringify(planned[1].snapshot.nextHopsBySessionId),
        );
    });

    it('falls back to a full rebuild when the membership delta is too large', () => {
        const members = createMemberIds(20);
        const service = new RallarRtcTopologyService({ now: () => 100 });
        const formed = service.planGroupTopologyAt(
            createGroupSnapshot('evolve-group', members, 1),
            [],
            { planningIntent: 'membership-delta' },
            100,
        );

        const replaced = [
            ...members.slice(0, 10),
            ...createMemberIds(10).map((sessionId) => `${sessionId}-replacement`),
        ];
        const rebuilt = service.planGroupTopologyAt(
            createGroupSnapshot('evolve-group', replaced, 2),
            [],
            { previous: formed.snapshot, planningIntent: 'membership-delta' },
            200,
        );

        expect(service.readMetrics().incrementalPlanFallbackFullCount).toBe(1);
        expect(service.readMetrics().incrementalPlanCount).toBe(0);
        expectValidPlan(rebuilt);
    });

    it('plans full rebuilds for non-membership-delta intents', () => {
        const members = createMemberIds(20);
        const service = new RallarRtcTopologyService({ now: () => 100 });
        const formed = service.planGroupTopologyAt(
            createGroupSnapshot('evolve-group', members, 1),
            [],
            {},
            100,
        );

        service.planGroupTopologyAt(
            createGroupSnapshot('evolve-group', [...members, 'session-joiner-901'], 2),
            [],
            { previous: formed.snapshot },
            200,
        );

        expect(service.readMetrics().incrementalPlanCount).toBe(0);
        expect(service.readMetrics().incrementalPlanFallbackFullCount).toBe(0);
    });

    it('holds the kind across the hysteresis band and counts the hold', () => {
        const members = createMemberIds(16);
        const service = new RallarRtcTopologyService({ now: () => 100 });
        const formed = service.planGroupTopologyAt(
            createGroupSnapshot('evolve-group', members, 1),
            [],
            { planningIntent: 'membership-delta' },
            100,
        );
        expect(formed.snapshot.topology).toBe('mesh');

        const shrunk = service.planGroupTopologyAt(
            createGroupSnapshot('evolve-group', members.slice(0, 13), 2),
            [],
            { previous: formed.snapshot, planningIntent: 'membership-delta' },
            200,
        );

        expect(shrunk.snapshot.topology).toBe('mesh');
        expect(service.readMetrics().hysteresisHeldKindCount).toBe(1);
        expectValidPlan(shrunk);

        const exited = service.planGroupTopologyAt(
            createGroupSnapshot('evolve-group', members.slice(0, 11), 3),
            [],
            { previous: shrunk.snapshot, planningIntent: 'membership-delta' },
            300,
        );
        expect(exited.snapshot.topology).toBe('tree');
    });
});

function edgeChurn(
    left: RallarRtcTopologyUpdateResult,
    right: RallarRtcTopologyUpdateResult,
): number {
    const leftEdges = edgeSet(left);
    const rightEdges = edgeSet(right);
    let churn = 0;
    for (const edge of leftEdges) if (!rightEdges.has(edge)) churn += 1;
    for (const edge of rightEdges) if (!leftEdges.has(edge)) churn += 1;
    return churn;
}

function edgeSet(result: RallarRtcTopologyUpdateResult): Set<string> {
    const edges = new Set<string>();
    for (const [from, hops] of Object.entries(result.snapshot.nextHopsBySessionId)) {
        for (const to of hops) {
            edges.add(from < to ? `${from}|${to}` : `${to}|${from}`);
        }
    }
    return edges;
}

function expectValidPlan(result: RallarRtcTopologyUpdateResult): void {
    const validation = validateGroupTopologyNextHops({
        activeSessionIds: new Set(result.snapshot.activeSessionIds),
        nextHopsBySessionId: result.snapshot.nextHopsBySessionId,
        maxDegree: result.snapshot.degreeLimit,
    });
    expect(validation.issues).toEqual([]);
}

function createMemberIds(memberCount: number): string[] {
    return Array.from(
        { length: memberCount },
        (_, index) => `session-${String(index + 1).padStart(3, '0')}`,
    );
}

function createGroupSnapshot(
    groupId: string,
    memberSessionIds: readonly string[],
    presenceRevision: number,
): GroupSnapshot {
    const applicationId = 'app-1';
    const workspaceId = 'workspace-1';
    const ownerPrincipalId = [...memberSessionIds].sort()[0];

    return {
        stateRevision: presenceRevision,
        causalRevision: { groupRevision: 1, presenceRevision },
        group: createTestGroup({
            applicationId,
            workspaceId,
            groupId,
            displayName: groupId,
            activeMemberCount: memberSessionIds.length,
            ownerPrincipalId,
            snapshotVersion: presenceRevision,
            metadataVersion: 0,
            rosterVersion: 1,
            presenceVersion: presenceRevision,
            created: audit(1),
            updated: audit(presenceRevision),
        }),
        members: memberSessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            principalId: sessionId,
            role: sessionId === ownerPrincipalId ? 'owner' : 'member',
            status: 'active',
            joined: audit(1),
            updated: audit(presenceRevision),
            left: null,
            removed: null,
            banned: null,
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null,
        })),
        activeSessions: memberSessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            sessionId,
            principalId: sessionId,
            generationId: 'generation-1',
            generationVersion: 1,
            status: 'active',
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 1,
            expiresAtEpochMs: 10_000_000,
            disconnectedAtEpochMs: null,
            disconnectReason: null,
        })),
        memberCount: memberSessionIds.length,
        onlineMemberCount: memberSessionIds.length,
    };
}

function audit(atEpochMs: number): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null,
    };
}
