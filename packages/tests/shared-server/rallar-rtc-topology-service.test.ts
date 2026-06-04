import { describe, expect, it } from 'vitest';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

describe('RallarRtcTopologyService', () => {
    it('creates scoped star topology for groups below tree size', () => {
        const group = createGroupSnapshot('room-1', createMemberIds(4));
        const service = new RallarRtcTopologyService({
            now: () => 100,
        });

        const result = service.updateGroupTopology(group);

        expect(result.changed).toBe(true);
        expect(result.snapshot.overlayId).toBe(toScopedOverlayId(group.group));
        expect(result.snapshot.topology).toBe('star');
        expect(result.snapshot.nextHopsBySessionId['peer-1']).toEqual([
            'peer-2',
            'peer-3',
            'peer-4',
        ]);
    });

    it.each([
        [5, 'tree'],
        [15, 'tree'],
        [16, 'mesh'],
    ] as const)(
        'creates degree-limited %s-member %s topology',
        (memberCount, topology) => {
            const group = createGroupSnapshot('room-1', createMemberIds(memberCount));
            const service = new RallarRtcTopologyService({
                now: () => 100,
            });

            const result = service.updateGroupTopology(group);

            expect(result.changed).toBe(true);
            expect(result.snapshot.topology).toBe(topology);

            for (const nextHops of Object.values(result.snapshot.nextHopsBySessionId)) {
                expect(nextHops.length).toBeLessThanOrEqual(5);
            }
        },
    );

    it('does not publish unchanged next-hop maps', () => {
        const group = createGroupSnapshot('room-1', createMemberIds(5));
        const service = new RallarRtcTopologyService({
            now: () => 100,
        });

        const first = service.updateGroupTopology(group);
        const second = service.updateGroupTopology({
            ...group,
            group: {
                ...group.group,
                snapshotVersion: 2,
            },
        });

        expect(first.changed).toBe(true);
        expect(second.changed).toBe(false);
        expect(second.snapshot).toBe(first.snapshot);
    });

    it('republishes tree topology when RTT measurements change next hops', () => {
        const memberSessionIds = createMemberIds(5);
        const group = createGroupSnapshot('room-1', memberSessionIds);
        const service = new RallarRtcTopologyService({
            now: () => 100,
        });

        const first = service.updateGroupTopology(group);
        const second = service.updateGroupTopology(
            group,
            createCentralRttMeasurements(memberSessionIds, 'peer-1'),
        );

        expect(first.changed).toBe(true);
        expect(second.changed).toBe(true);
        expect(second.snapshot.version).toBe(2);
        expect(second.snapshot.nextHopsBySessionId['peer-1']).toHaveLength(4);
        expect(second.snapshot.nextHopsBySessionId).not.toEqual(
            first.snapshot.nextHopsBySessionId,
        );
    });

    it('continues versioning from a supplied previous snapshot', () => {
        const memberSessionIds = createMemberIds(5);
        const group = createGroupSnapshot('room-1', memberSessionIds);
        const firstWorker = new RallarRtcTopologyService({
            now: () => 100,
        });
        const secondWorker = new RallarRtcTopologyService({
            now: () => 200,
        });

        const first = firstWorker.updateGroupTopology(group);
        const second = secondWorker.updateGroupTopology(
            group,
            createCentralRttMeasurements(memberSessionIds, 'peer-1'),
            {
                previous: first.snapshot,
            },
        );

        expect(second.changed).toBe(true);
        expect(second.previous).toBe(first.snapshot);
        expect(second.snapshot.version).toBe(2);
        expect(second.snapshot.createdAtEpochMs).toBe(
            first.snapshot.createdAtEpochMs,
        );
        expect(second.snapshot.updatedAtEpochMs).toBe(200);
    });

    it('hydrates fresh service memory from an unchanged supplied snapshot', () => {
        const group = createGroupSnapshot('room-1', createMemberIds(5));
        const firstWorker = new RallarRtcTopologyService({
            now: () => 100,
        });
        const secondWorker = new RallarRtcTopologyService({
            now: () => 200,
        });

        const first = firstWorker.updateGroupTopology(group);
        const second = secondWorker.updateGroupTopology(group, [], {
            previous: first.snapshot,
        });

        expect(second.changed).toBe(false);
        expect(second.snapshot).toBe(first.snapshot);
        expect(secondWorker.readSnapshot(group)).toBe(first.snapshot);
    });

    it('debounces RTT-triggered topology rebuilds until the pending update is due', () => {
        let now = 1_000;
        const memberSessionIds = createMemberIds(5);
        const group = createGroupSnapshot('room-1', memberSessionIds);
        const service = new RallarRtcTopologyService({
            now: () => now,
            rttRebuildDebounceMs: 50,
        });

        const first = service.updateGroupTopology(group);
        const queued = service.queueRttTopologyUpdate(group);

        expect(queued.newlyQueued).toBe(true);
        expect(queued.immediate).toBe(false);
        expect(queued.delayMs).toBe(50);
        expect(
            service.flushDueRttTopologyUpdate(
                group,
                createCentralRttMeasurements(memberSessionIds, 'peer-1'),
            ),
        ).toBeUndefined();

        now = 1_049;
        expect(
            service.flushDueRttTopologyUpdate(
                group,
                createCentralRttMeasurements(memberSessionIds, 'peer-1'),
            ),
        ).toBeUndefined();

        now = 1_050;
        const second = service.flushDueRttTopologyUpdate(
            group,
            createCentralRttMeasurements(memberSessionIds, 'peer-1'),
        );

        expect(second?.changed).toBe(true);
        expect(second?.snapshot.version).toBe(first.snapshot.version + 1);
        expect(second?.snapshot.nextHopsBySessionId['peer-1']).toHaveLength(4);
    });

    it('coalesces multiple RTT queue requests into one pending deadline', () => {
        let now = 1_000;
        const group = createGroupSnapshot('room-1', createMemberIds(5));
        const service = new RallarRtcTopologyService({
            now: () => now,
            rttRebuildDebounceMs: 50,
        });

        service.updateGroupTopology(group);
        const first = service.queueRttTopologyUpdate(group);
        now = 1_025;
        const second = service.queueRttTopologyUpdate(group);

        expect(second.newlyQueued).toBe(false);
        expect(second.dueAtEpochMs).toBe(first.dueAtEpochMs);
        expect(second.delayMs).toBe(25);
    });
});

function createMemberIds(count: number): readonly string[] {
    return Array.from({ length: count }, (_, index) => `peer-${index + 1}`);
}

function createCentralRttMeasurements(
    memberSessionIds: readonly string[],
    centralSessionId: string,
): readonly RttMeasurementInfo[] {
    const measurements: RttMeasurementInfo[] = [];
    let version = 1;

    for (let i = 0; i < memberSessionIds.length; i++) {
        for (let j = i + 1; j < memberSessionIds.length; j++) {
            const from = memberSessionIds[i];
            const to = memberSessionIds[j];
            measurements.push({
                sessionIdFrom: from,
                sessionIdTo: to,
                rttMs: from === centralSessionId || to === centralSessionId
                    ? 1
                    : 100,
                createdAtEpochMs: version,
                version: version++,
            });
        }
    }

    return measurements;
}

function createGroupSnapshot(
    groupId: string,
    memberSessionIds: readonly string[],
): GroupSnapshot {
    const applicationId = 'app-1';
    const workspaceId = 'workspace-1';

    return {
        group: {
            applicationId,
            workspaceId,
            groupId,
            displayName: groupId,
            kind: 'room',
            status: 'active',
            joinMode: 'open',
            metadata: {},
            snapshotVersion: 1,
            metadataVersion: 0,
            rosterVersion: 1,
            presenceVersion: 0,
            created: {
                atEpochMs: 1,
                byPrincipalId: 'owner',
            },
            updated: {
                atEpochMs: 1,
                byPrincipalId: 'owner',
            },
        },
        members: memberSessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            principalId: sessionId,
            role: 'member',
            status: 'active',
            joined: {
                atEpochMs: 1,
                byPrincipalId: 'owner',
            },
            updated: {
                atEpochMs: 1,
                byPrincipalId: 'owner',
            },
        })),
        activeSessions: memberSessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            sessionId,
            principalId: sessionId,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 1,
            expiresAtEpochMs: 60_000,
        })),
        memberCount: memberSessionIds.length,
        onlineMemberCount: memberSessionIds.length,
    };
}
