import { describe, expect, it } from 'vitest';

import { GROUP_LIFECYCLE_STATES, type GroupLifecycleState } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';

import { resolveGroupTopologyConfig } from '@shared-server/rallar-system/topology/config/group-topology-config.ts';
import type { ReconcileGroupTopologyResult } from '@shared-server/rallar-system/topology/planning/group-topology-planning-contracts.ts';
import { GroupTopologyPlanningService } from '@shared-server/rallar-system/topology/planning/group-topology-planning-service.ts';
import type { GroupTopologyReplanningRead } from '@shared-server/rallar-system/topology/planning/resolve-topology-plan-action.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';
import { requirePlannedTopology } from '@shared-test/shared-server/require-planned-topology.ts';
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
            replanning: 'auto',
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
                replanning: 'debounced',
                nowEpochMs: 2_000
            },
            undefined,
            { intent: 'full-rebuild', origin: 'automatic' }
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
            undefined,
            { intent: 'full-rebuild', origin: 'automatic' }
        );

        expect(requirePlannedTopology(result).snapshot.state).toBe('removed');
        expect(Object.values(requirePlannedTopology(result).snapshot.nextHopsBySessionId).flat()).toEqual([]);
    });

    it('drops a previously planned topology when the group returns to FORMING', () => {
        const active = groupWithSessionsIn('active');
        const service = createPlanningService({ group: active });
        const planned = requirePlannedTopology(service.computeTopologyFromAuthority(
            planningAuthority(active),
            undefined,
            { intent: 'full-rebuild', origin: 'automatic' }
        ));
        expect(planned.snapshot.state).not.toBe('removed');

        const forming = groupWithSessionsIn('forming');
        const held = createPlanningService({ group: forming }).computeTopologyFromAuthority(
            planningAuthority(forming),
            planned.snapshot,
            { intent: 'full-rebuild', origin: 'automatic' }
        );
        expect(requirePlannedTopology(held).snapshot.state).toBe('removed');
    });

    it('resolves every stage with no stored layout: removal for dormant and forming, a first plan everywhere else', () => {
        for (const lifecycleState of GROUP_LIFECYCLE_STATES) {
            const group = groupWithSessionsIn(lifecycleState);
            const service = createPlanningService({ group });

            const result = requirePlannedTopology(service.computeTopologyFromAuthority(
                planningAuthority(group),
                undefined,
                { intent: 'full-rebuild', origin: 'automatic' }
            ));

            if (lifecycleState === 'dormant' || lifecycleState === 'forming') {
                expect(result.snapshot.state).toBe('removed');
                continue;
            }
            // Freeze is replacement suppression, never establishment
            // suppression: a dialing stage still produces its first layout.
            expect(result.snapshot.state).not.toBe('removed');
            expect(result.snapshot.activeSessionIds).toEqual(['session-a', 'session-b']);
        }
    });

    it('resolves every stage against an active stored layout to the 4b disposition table', () => {
        const seed = groupWithSessionsIn('active');
        const stored = requirePlannedTopology(
            createPlanningService({ group: seed }).computeTopologyFromAuthority(
                planningAuthority(seed),
                undefined,
                { intent: 'full-rebuild', origin: 'automatic' }
            )
        ).snapshot;
        const frozenStages: GroupLifecycleState[] = ['connecting', 'reconnecting'];
        for (const lifecycleState of GROUP_LIFECYCLE_STATES) {
            const group = groupWithSessionsIn(lifecycleState);
            const service = createPlanningService({ group });

            const result = service.computeTopologyFromAuthority(
                planningAuthority(group),
                stored,
                { intent: 'full-rebuild', origin: 'automatic' }
            );

            if (frozenStages.includes(lifecycleState)) {
                expect(result).toEqual({ action: 'frozen', current: stored });
                continue;
            }
            const planned = requirePlannedTopology(result);
            if (lifecycleState === 'dormant' || lifecycleState === 'forming') {
                expect(planned.snapshot.state).toBe('removed');
                continue;
            }
            expect(planned.snapshot.state).not.toBe('removed');
        }
    });

    it('freezes automatic replanning of an active stored layout under commanded mode, but plans commanded work', () => {
        const group = groupWithSessionsIn('active');
        const service = createPlanningService({ group });
        const stored = requirePlannedTopology(service.computeTopologyFromAuthority(
            planningAuthority(group),
            undefined,
            { intent: 'full-rebuild', origin: 'automatic' }
        )).snapshot;

        const automatic = service.computeTopologyFromAuthority(
            planningAuthority(group, 'commanded'),
            stored,
            { intent: 'full-rebuild', origin: 'automatic' }
        );
        expect(automatic).toEqual({ action: 'frozen', current: stored });

        const commanded = service.computeTopologyFromAuthority(
            planningAuthority(group, 'commanded'),
            stored,
            { intent: 'full-rebuild', origin: 'commanded' }
        );
        expect(requirePlannedTopology(commanded).snapshot.state).not.toBe('removed');
    });

    it('fails automatic replanning closed on a corrupt policy, and C7: a departure does not move a commanded layout', () => {
        const group = groupWithSessionsIn('active');
        const service = createPlanningService({ group });
        const stored = requirePlannedTopology(service.computeTopologyFromAuthority(
            planningAuthority(group),
            undefined,
            { intent: 'full-rebuild', origin: 'automatic' }
        )).snapshot;

        expect(service.computeTopologyFromAuthority(
            planningAuthority(group, 'corrupt'),
            stored,
            { intent: 'full-rebuild', origin: 'automatic' }
        )).toEqual({ action: 'frozen', current: stored });

        // C7: presence expiry flows in as automatic membership-delta work; a
        // commanded group keeps its stored layout naming the departed session.
        const departed = {
            ...group,
            activeSessions: group.activeSessions.slice(0, 1),
            onlineMemberCount: 1
        };
        const afterDeparture = service.computeTopologyFromAuthority(
            planningAuthority(departed, 'commanded'),
            stored,
            { intent: 'membership-delta', origin: 'automatic' }
        );
        expect(afterDeparture).toEqual({ action: 'frozen', current: stored });
    });

    it('freezes the local reconfigure path for a dialing stage', async () => {
        const group = groupWithSessionsIn('connecting');
        const topologyService = new RallarRtcTopologyService({ now: () => 2_000 });
        const service = createPlanningService({ group, topologyService });
        const stored = requirePlannedTopology(service.computeTopologyFromAuthority(
            planningAuthority(group),
            undefined,
            { intent: 'full-rebuild', origin: 'automatic' }
        )).snapshot;
        topologyService.observeCommittedTopologySnapshot(stored);

        const response = await service.reconfigureGroupTopology({
            groupRef: group.group,
            groupSnapshot: group,
            publisher: () => 1
        });

        expect(response.changed).toBe(false);
        expect(response.published).toBe(false);
        expect(response.snapshot).toEqual(topologyService.readSnapshot(group));
        // A frozen plan is a policy hold, not a publish attempt.
        expect(topologyService.readMetrics().topologyPlanFrozenCount).toBe(1);
        expect(topologyService.readMetrics().topologyPublishAttemptCount).toBe(0);
    });

    it('does not report a topology publication when the delivery owner reaches no session', async () => {
        const group = groupWithSessionsIn('active');
        const service = createPlanningService({ group });

        const response = await service.reconfigureGroupTopology({
            groupRef: group.group,
            groupSnapshot: group,
            publisher: () => 0
        });

        expect(response.published).toBe(false);
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

function planningAuthority(
    group: ReturnType<typeof createTopologyTestGroupSnapshot>,
    replanning: GroupTopologyReplanningRead = 'auto'
) {
    return {
        group,
        config: resolveGroupTopologyConfig({}),
        kindHysteresisWidths: { meshExitWidth: 4, treeExitWidth: 0 },
        rttMeasurements: [],
        replanning,
        nowEpochMs: 2_000
    };
}

function createPlanningService(input: {
    group: ReturnType<typeof createTopologyTestGroupSnapshot>;
    config?: ReturnType<typeof resolveGroupTopologyConfig>;
    topologyService?: RallarRtcTopologyService;
}): GroupTopologyPlanningService {
    const topologyService = input.topologyService ?? new RallarRtcTopologyService({ now: () => 2_000 });
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
