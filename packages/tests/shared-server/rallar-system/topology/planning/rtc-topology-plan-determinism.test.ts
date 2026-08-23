import { describe, expect, it } from 'vitest';

import { validateGroupTopologyNextHops } from '@shared-graph/group-topology-validation.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { AuditStamp, GroupSnapshot } from '@shared/api/group-types.ts';
import { createTestGroup } from '../../../../create-test-group.ts';

describe('RTC topology plan determinism', () => {
    const sizes = [2, 4, 5, 6, 12, 15, 16, 20, 33, 50, 64];

    it.each(sizes.map((memberCount) => ({ memberCount })))(
        'plans byte-identical graphs for shuffled member orders (N=$memberCount, no RTT)',
        ({ memberCount }) => {
            const members = createMemberIds(memberCount);
            const reference = planForOrder(members, []);

            for (const seed of [7, 23, 41]) {
                const shuffledPlan = planForOrder(shuffled(members, seed), []);
                expect(JSON.stringify(shuffledPlan.snapshot.nextHopsBySessionId)).toBe(
                    JSON.stringify(reference.snapshot.nextHopsBySessionId)
                );
                expect(shuffledPlan.snapshot.topology).toBe(reference.snapshot.topology);
                expect(shuffledPlan.snapshot.activeSessionIds).toEqual(reference.snapshot.activeSessionIds);
            }

            const validation = validateGroupTopologyNextHops({
                activeSessionIds: new Set(reference.snapshot.activeSessionIds),
                nextHopsBySessionId: reference.snapshot.nextHopsBySessionId,
                maxDegree: reference.snapshot.degreeLimit
            });
            expect(validation.issues).toEqual([]);
        }
    );

    it('plans byte-identical graphs for shuffled member orders with mixed RTT (N=20)', () => {
        const members = createMemberIds(20);
        const rttMeasurements: RttMeasurementInfo[] = members
            .slice(0, 8)
            .map((sessionId, index) => ({
                sessionIdFrom: sessionId,
                sessionIdTo: members[(index + 3) % 8],
                rttMs: 5 + index * 7,
                createdAtEpochMs: 1,
                version: 1
            }))
            .filter((rtt) => rtt.sessionIdFrom !== rtt.sessionIdTo);
        const reference = planForOrder(members, rttMeasurements);

        for (const seed of [11, 29]) {
            const shuffledPlan = planForOrder(shuffled(members, seed), shuffled(rttMeasurements, seed));
            expect(JSON.stringify(shuffledPlan.snapshot.nextHopsBySessionId)).toBe(
                JSON.stringify(reference.snapshot.nextHopsBySessionId)
            );
        }
    });

    it('replans an unchanged member set as unchanged when seeded with the previous plan', () => {
        const members = createMemberIds(20);
        const first = planForOrder(members, []);
        const service = new RallarRtcTopologyService({ now: () => 200 });
        const replanned = service.planGroupTopologyAt(
            createGroupSnapshot('determinism-group', shuffled(members, 13)),
            [],
            { previous: first.snapshot },
            200
        );

        expect(replanned.changed).toBe(false);
        expect(replanned.snapshot).toBe(first.snapshot);
    });

    it('emits canonically ordered next-hop arrays for every kind', () => {
        for (const memberCount of [3, 8, 20]) {
            const plan = planForOrder(shuffled(createMemberIds(memberCount), 3), []);
            for (const nextHops of Object.values(plan.snapshot.nextHopsBySessionId)) {
                const sorted = [...nextHops].sort();
                expect(nextHops).toEqual(sorted);
            }
        }
    });
});

function planForOrder(members: readonly string[], rttMeasurements: readonly RttMeasurementInfo[]) {
    const service = new RallarRtcTopologyService({ now: () => 100 });
    return service.planGroupTopologyAt(
        createGroupSnapshot('determinism-group', members),
        rttMeasurements,
        {},
        100
    );
}

function shuffled<T>(values: readonly T[], seed: number): T[] {
    const result = [...values];
    let state = seed;
    for (let index = result.length - 1; index > 0; index--) {
        state = (state * 1103515245 + 12345) % 2147483648;
        const swap = state % (index + 1);
        [result[index], result[swap]] = [result[swap], result[index]];
    }
    return result;
}

function createMemberIds(memberCount: number): string[] {
    return Array.from(
        { length: memberCount },
        (_, index) => `session-${String(index + 1).padStart(3, '0')}`
    );
}

function createGroupSnapshot(groupId: string, memberSessionIds: readonly string[]): GroupSnapshot {
    const applicationId = 'app-1';
    const workspaceId = 'workspace-1';
    const ownerPrincipalId = [...memberSessionIds].sort()[0];

    return {
        causalRevision: { groupRevision: 1, presenceRevision: 0 },
        group: createTestGroup({
            applicationId,
            workspaceId,
            groupId,
            displayName: groupId,
            activeMemberCount: memberSessionIds.length,
            ownerPrincipalId,
            snapshotVersion: 1,
            metadataVersion: 0,
            rosterVersion: 1,
            presenceVersion: 0,
            created: audit(1),
            updated: audit(1)
        }),
        members: memberSessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            principalId: sessionId,
            role: sessionId === ownerPrincipalId ? 'owner' : 'member',
            status: 'active',
            joined: audit(1),
            updated: audit(1),
            left: null,
            removed: null,
            banned: null,
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null
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
            disconnectReason: null
        })),
        memberCount: memberSessionIds.length,
        onlineMemberCount: memberSessionIds.length
    };
}

function audit(atEpochMs: number): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null
    };
}
