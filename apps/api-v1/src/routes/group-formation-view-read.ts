import type {
    GroupLifecyclePolicyRead
} from '@shared-server/rallar-system/group-state/persistence/group-lifecycle-policy-repository.ts';
import { computeGroupFormationReadiness } from '@shared/api/group-lifecycle/compute-group-formation-readiness.ts';
import type { GroupFormationView } from '@shared/api/group-lifecycle/group-formation-view.ts';
import { createDefaultGroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import {
    resolveGroupLifecycleManagers,
    toGroupLifecycleElectionKey
} from '@shared/api/group-lifecycle/resolve-group-lifecycle-managers.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { GraphTopologyRoutePlanning, GraphTopologyRouteQuery } from './graph-topology-routes.ts';

export interface ReadGroupFormationViewDependencies {
    readonly topologyQuery: GraphTopologyRouteQuery;
    readonly topologyPlanning: GraphTopologyRoutePlanning;
    readonly readLifecyclePolicy: (ref: GroupRef) => Promise<GroupLifecyclePolicyRead>;
}

export async function readGroupFormationView(
    groupRef: GroupRef,
    snapshot: GroupSnapshot,
    deps: ReadGroupFormationViewDependencies
): Promise<GroupFormationView> {
    const [authority, view] = await Promise.all([
        deps.topologyPlanning.readTopologyPlanningAuthority({
            groupRef,
            knownGroup: snapshot,
            snapshotSelection: 'prefer-current'
        }),
        deps.topologyQuery.readTopologyView(groupRef) as Promise<
            Readonly<{ snapshot: RallarOverlayTopologySnapshot | null; }>
        >
    ]);
    const group = authority.group.group;
    const policyRead = await deps.readLifecyclePolicy(groupRef);
    return {
        groupRef,
        lifecycleState: group.lifecycleState,
        formationEpoch: group.formationEpoch,
        formationAttemptCount: group.formationAttemptCount,
        lastFormationOutcome: group.lastFormationOutcome,
        establishmentStartedAtEpochMs: group.establishmentStartedAtEpochMs,
        readiness: view.snapshot === null
            ? { plannedEdgeCount: 0, observedEdgeCount: 0, observedRate: 1 }
            : computeGroupFormationReadiness({
                planned: view.snapshot,
                rttMeasurements: authority.rttMeasurements,
                nowEpochMs: authority.nowEpochMs
            }),
        managerPrincipalIds: policyRead.status === 'corrupt'
            // Fail closed: an unreadable stored policy must not resolve authority.
            ? []
            : resolveGroupLifecycleManagers({
                manager: (policyRead.status === 'present'
                    ? policyRead.policy
                    : createDefaultGroupLifecyclePolicy()).manager,
                ownerPrincipalId: group.ownerPrincipalId,
                formationElectorate: group.formationElectorate,
                formationEpoch: group.formationEpoch,
                groupKey: toGroupLifecycleElectionKey(groupRef),
                activePrincipalIds: new Set(
                    authority.group.members
                        .filter((member) => member.status === 'active')
                        .map((member) => member.principalId)
                ),
                rankByPrincipalId: null
            })
    };
}
