import { describe, expect, it } from 'vitest';

import type { GroupLifecycleState } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';

import { RallarRtcTopologyService } from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
import { resolveGroupTopologyConfig } from '@shared-server/rallar-system/topology/config/group-topology-config.ts';
import { GroupTopologyPlanningService } from '@shared-server/rallar-system/topology/planning/group-topology-planning-service.ts';
import { createTestGroup } from '../../../../create-test-group.ts';

import { createTopologyTestGroupRef, createTopologyTestGroupSnapshot } from '../config/mutation/group-topology-config-mutation-test-fixtures.ts';

describe('GroupTopologyPlanningService', () => {
    it('reads one explicit planning authority from query, RTT, and RTC clock owners', async () => {
        const group = createTopologyTestGroupSnapshot();
        const config = resolveGroupTopologyConfig({ requestOptions: { degreeLimit: 7 } });
        const service = createPlanningService({ group, config });

        await expect(
            service.readTopologyPlanningAuthority({
                groupRef: group.group,
                requestOptions: { degreeLimit: 7 },
                snapshotSelection: 'prefer-current'
            })
        ).resolves.toEqual({
            group,
            config,
            kindHysteresisWidths: { meshExitWidth: 4, treeExitWidth: 0 },
            rttMeasurements: [],
            nowEpochMs: 2_000
        });
    });

    it('materializes an inactive group as a complete removed topology snapshot', () => {
        const group = createTopologyTestGroupSnapshot();
        const inactive = {
            ...group,
            group: createTestGroup({
                ...group.group,
                status: 'archived',
                archived: {
                    atEpochMs: 1_500,
                    actor: { kind: 'principal', principalId: 'owner' },
                    reason: null,
                    traceId: null,
                    requestId: null
                },
                deleted: null
            })
        };
        const service = createPlanningService({ group: inactive });

        const result = service.computeTopologyFromAuthority(
            {
                group: inactive,
                config: resolveGroupTopologyConfig({}),
                kindHysteresisWidths: { meshExitWidth: 4, treeExitWidth: 0 },
                rttMeasurements: [],
                nowEpochMs: 2_000
            },
            undefined
        );

        expect(result).toMatchObject({
            previous: null,
            changed: true,
            snapshot: {
                state: 'removed',
                groupRef: createTopologyTestGroupRef(),
                activeSessionIds: [],
                nextHopsBySessionId: {}
            }
        });
    });

    it('holds topology planning while the group is FORMING', () => {
        const forming = groupWithSessionsIn('forming');
        const service = createPlanningService({ group: forming });

        const result = service.computeTopologyFromAuthority(
            planningAuthority(forming),
            undefined
        );

        expect(result.snapshot.state).toBe('removed');
        expect(Object.values(result.snapshot.nextHopsBySessionId).flat()).toEqual([]);
    });

    it('drops a previously planned topology when the group returns to FORMING', () => {
        const active = groupWithSessionsIn('active');
        const service = createPlanningService({ group: active });
        const planned = service.computeTopologyFromAuthority(
            planningAuthority(active),
            undefined
        );
        expect(planned.snapshot.state).not.toBe('removed');

        const forming = groupWithSessionsIn('forming');
        const held = createPlanningService({ group: forming }).computeTopologyFromAuthority(
            planningAuthority(forming),
            planned.snapshot
        );
        expect(held.snapshot.state).toBe('removed');
    });

    it('plans in every non-forming lifecycle state', () => {
        for (const lifecycleState of ['establishing', 'active', 'reconfiguring'] as const) {
            const group = groupWithSessionsIn(lifecycleState);
            const service = createPlanningService({ group });

            const result = service.computeTopologyFromAuthority(
                planningAuthority(group),
                undefined
            );

            expect(result.snapshot.state).not.toBe('removed');
            expect(result.snapshot.activeSessionIds).toEqual(['session-a', 'session-b']);
        }
    });
});

function groupWithSessionsIn(
    lifecycleState: GroupLifecycleState
): ReturnType<typeof createTopologyTestGroupSnapshot> {
    const base = createTopologyTestGroupSnapshot();
    const sessions = ['session-a', 'session-b'].map((sessionId) => ({
        ...createTopologyTestGroupRef(),
        principalId: sessionId,
        sessionId,
        generationId: `generation-${sessionId}`,
        generationVersion: 1,
        status: 'active' as const,
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1_999,
        expiresAtEpochMs: 60_000,
        disconnectedAtEpochMs: null,
        disconnectReason: null
    }));
    return {
        ...base,
        group: { ...base.group, lifecycleState, formationEpoch: 1 },
        activeSessions: sessions,
        onlineMemberCount: sessions.length
    };
}

function planningAuthority(group: ReturnType<typeof createTopologyTestGroupSnapshot>) {
    return {
        group,
        config: resolveGroupTopologyConfig({}),
        kindHysteresisWidths: { meshExitWidth: 4, treeExitWidth: 0 },
        rttMeasurements: [],
        nowEpochMs: 2_000
    };
}

function createPlanningService(input: {
    group: ReturnType<typeof createTopologyTestGroupSnapshot>;
    config?: ReturnType<typeof resolveGroupTopologyConfig>;
}): GroupTopologyPlanningService {
    const topologyService = new RallarRtcTopologyService({ now: () => 2_000 });
    return new GroupTopologyPlanningService({
        findGroupSnapshotByRef: async () => input.group,
        readCurrentGroupSnapshot: async () => input.group,
        readRttMeasurements: async () => [],
        topologyMode: 'local',
        queryService: {
            readConfig: async () => input.config ?? resolveGroupTopologyConfig({}),
            readResolvedTopologyConfig: async () => input.config ?? resolveGroupTopologyConfig({})
        },
        topologyService
    });
}
