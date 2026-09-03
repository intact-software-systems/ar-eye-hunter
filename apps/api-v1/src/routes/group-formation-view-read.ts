import type {
    GroupLifecyclePolicyRead
} from '@shared-server/rallar-system/group-state/persistence/group-lifecycle-policy-repository.ts';
import type { GroupTopologyPlanningAuthority } from '@shared-server/rallar-system/topology/planning/group-topology-planning-authority.ts';
import { computeAuthorityTopologyInputFingerprint } from '@shared-server/rallar-system/topology/replay/work/rtc-topology-input-fingerprint.ts';
import { computeLayoutStale } from '@shared/api/group-lifecycle/compute-group-activation-condition.ts';
import {
    computeGroupFormationReadiness,
    type GroupFormationReadiness
} from '@shared/api/group-lifecycle/compute-group-formation-readiness.ts';
import type { GroupFormationView } from '@shared/api/group-lifecycle/group-formation-view.ts';
import { toGroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
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
    /** The planned slot's stored topology-input fingerprint; null before a planning cycle stored one. */
    readonly readPlannedLayoutFingerprint: (ref: GroupRef) => Promise<string | null>;
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
        deps.topologyQuery.readTopologyView(groupRef)
    ]);
    const group = authority.group.group;
    const [policyRead, layoutStale] = await Promise.all([
        deps.readLifecyclePolicy(groupRef),
        readLayoutStale({ groupRef, authority, planned: view.snapshot, deps })
    ]);
    return {
        groupRef,
        lifecycleState: group.lifecycleState,
        formationEpoch: group.formationEpoch,
        formationAttemptCount: group.formationAttemptCount,
        lastFormationOutcome: group.lastFormationOutcome,
        establishmentStartedAtEpochMs: group.establishmentStartedAtEpochMs,
        readiness: toFormationReadiness(view.snapshot, authority),
        managerPrincipalIds: resolveManagerPrincipalIds(groupRef, authority, policyRead),
        layoutStale,
        pending: view.pending
    };
}

interface ReadLayoutStaleInput {
    readonly groupRef: GroupRef;
    readonly authority: GroupTopologyPlanningAuthority;
    readonly planned: RallarOverlayTopologySnapshot | null;
    readonly deps: ReadGroupFormationViewDependencies;
}

async function readLayoutStale({ groupRef, authority, planned, deps }: ReadLayoutStaleInput): Promise<boolean> {
    const acceptedIdentity = authority.group.group.acceptedLayoutIdentity;
    if (acceptedIdentity === null) {
        return false;
    }
    const [plannedFingerprint, planningAuthorityFingerprint] = await Promise.all([
        deps.readPlannedLayoutFingerprint(groupRef),
        computeAuthorityTopologyInputFingerprint(authority)
    ]);
    return computeLayoutStale({
        acceptedIdentity,
        plannedIdentity: planned === null ? null : toGroupLayoutIdentity(planned),
        plannedFingerprint,
        planningAuthorityFingerprint
    });
}

function toFormationReadiness(
    planned: RallarOverlayTopologySnapshot | null,
    authority: GroupTopologyPlanningAuthority
): GroupFormationReadiness {
    return planned === null
        ? { plannedEdgeCount: 0, observedEdgeCount: 0, observedRate: 1 }
        : computeGroupFormationReadiness({
            planned,
            rttMeasurements: authority.rttMeasurements,
            nowEpochMs: authority.nowEpochMs
        });
}

function resolveManagerPrincipalIds(
    groupRef: GroupRef,
    authority: GroupTopologyPlanningAuthority,
    policyRead: GroupLifecyclePolicyRead
): readonly string[] {
    if (policyRead.status === 'corrupt') {
        // Fail closed: an unreadable stored policy must not resolve authority.
        return [];
    }
    const group = authority.group.group;
    return resolveGroupLifecycleManagers({
        manager: (policyRead.status === 'present' ? policyRead.policy : createDefaultGroupLifecyclePolicy()).manager,
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
    });
}
