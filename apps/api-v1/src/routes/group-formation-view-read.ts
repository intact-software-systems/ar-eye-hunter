import type {
    GroupLifecyclePolicyRead
} from '@shared-server/rallar-system/group-state/persistence/group-lifecycle-policy-repository.ts';
import type { GroupTopologyPlanningAuthority } from '@shared-server/rallar-system/topology/planning/group-topology-planning-authority.ts';
import { computeAuthorityTopologyInputFingerprint } from '@shared-server/rallar-system/topology/replay/work/rtc-topology-input-fingerprint.ts';
import {
    computeGroupActivationCondition,
    computeLayoutStale,
    resolveCoverageBasisLayoutIdentity,
    resolveGroupActivationRemediation,
    resolveGroupBusinessLiveness,
    type GroupActivationCondition,
    type GroupActivationRemediation,
    type GroupCoverageObservation
} from '@shared/api/group-lifecycle/compute-group-activation-condition.ts';
import {
    computeGroupFormationReadiness,
    type GroupFormationReadiness
} from '@shared/api/group-lifecycle/compute-group-formation-readiness.ts';
import type { GroupFormationView } from '@shared/api/group-lifecycle/group-formation-view.ts';
import { toGroupLayoutIdentity, type GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { createDefaultGroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { GroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import { isFormationAttemptBudgetExhausted } from '@shared/api/group-lifecycle/group-lifecycle-transitions.ts';
import {
    resolveGroupLifecycleManagers,
    toGroupLifecycleElectionKey
} from '@shared/api/group-lifecycle/resolve-group-lifecycle-managers.ts';
import type { Group, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
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
    // One resolution for every field the policy answers: a corrupt stored
    // policy resolves no manager, no budget and no coverage thresholds, so
    // the whole surface fails closed together rather than per field.
    const policy = resolveReadablePolicy(policyRead);
    const readiness = toFormationReadiness(view.snapshot, authority);
    const status = computeActivationStatus({
        group,
        policy,
        planned: view.snapshot,
        readiness,
        layoutStale,
        replanQueued: view.pending !== null,
        nowEpochMs: authority.nowEpochMs
    });
    return {
        groupRef,
        lifecycleState: group.lifecycleState,
        formationEpoch: group.formationEpoch,
        formationAttemptCount: group.formationAttemptCount,
        lastFormationOutcome: group.lastFormationOutcome,
        establishmentStartedAtEpochMs: group.establishmentStartedAtEpochMs,
        readiness,
        managerPrincipalIds: resolveManagerPrincipalIds(groupRef, authority, policy),
        layoutStale,
        pending: view.pending,
        maxFormationAttempts: policy === null ? null : policy.activation.maxFormationAttempts,
        condition: status.condition,
        remediation: status.remediation,
        coverageBasisLayoutIdentity: status.coverageBasisLayoutIdentity
    };
}

/** The stored policy as a value, or null when it is unreadable. */
function resolveReadablePolicy(policyRead: GroupLifecyclePolicyRead): GroupLifecyclePolicy | null {
    if (policyRead.status === 'corrupt') {
        return null;
    }
    return policyRead.status === 'present' ? policyRead.policy : createDefaultGroupLifecyclePolicy();
}

interface ComputeActivationStatusInput {
    readonly group: Group;
    readonly policy: GroupLifecyclePolicy | null;
    readonly planned: RallarOverlayTopologySnapshot | null;
    readonly readiness: GroupFormationReadiness;
    readonly layoutStale: boolean;
    readonly replanQueued: boolean;
    readonly nowEpochMs: number;
}

interface GroupActivationStatus {
    readonly condition: GroupActivationCondition;
    readonly remediation: GroupActivationRemediation;
    readonly coverageBasisLayoutIdentity: GroupLayoutIdentity | null;
}

/**
 * Both axes at this read (product decision 30). An unreadable policy carries
 * no thresholds and no budget, so it reports no coverage and no replanning
 * obligation -- the same fail-closed answer the manager resolution gives.
 */
function computeActivationStatus(input: ComputeActivationStatusInput): GroupActivationStatus {
    const { group, policy, readiness, layoutStale, replanQueued } = input;
    const business = resolveGroupBusinessLiveness(group, input.nowEpochMs);
    const coverageBasisLayoutIdentity = policy === null ? null : resolveCoverageBasisLayoutIdentity({
        lifecycleState: group.lifecycleState,
        accepted: group.acceptedLayoutIdentity ?? undefined,
        plannedCandidate: input.planned === null ? undefined : toGroupLayoutIdentity(input.planned)
    }) ?? null;
    const attemptBudgetExhausted = policy !== null && isFormationAttemptBudgetExhausted({
        activation: policy.activation,
        formationAttemptCount: group.formationAttemptCount
    });
    return {
        condition: computeGroupActivationCondition({
            business,
            lifecycleState: group.lifecycleState,
            attemptBudgetExhausted,
            coverage: toCoverageObservation(policy, readiness, coverageBasisLayoutIdentity)
        }),
        remediation: resolveGroupActivationRemediation({
            business,
            lifecycleState: group.lifecycleState,
            attemptBudgetExhausted,
            // Without the stored policy the mode is unknown, and only the
            // `commanded` mode turns a stale layout into an obligation.
            replanning: policy?.topology.replanning ?? 'auto',
            layoutStale,
            replanQueued
        }),
        coverageBasisLayoutIdentity
    };
}

/**
 * `dwellSatisfied` is false at every read: the dwell clock belongs to the
 * status writer, so `degraded` and the dwell-held `failed` band are not
 * reported until that slice lands (implementation decision I36).
 */
function toCoverageObservation(
    policy: GroupLifecyclePolicy | null,
    readiness: GroupFormationReadiness,
    coverageBasisLayoutIdentity: GroupLayoutIdentity | null
): GroupCoverageObservation | undefined {
    if (policy === null || coverageBasisLayoutIdentity === null) {
        return undefined;
    }
    return {
        coverageRate: readiness.observedRate,
        successRate: policy.activation.successRate,
        minimumViableRate: policy.activation.minimumViableRate,
        dwellSatisfied: false
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
    policy: GroupLifecyclePolicy | null
): readonly string[] {
    if (policy === null) {
        // Fail closed: an unreadable stored policy must not resolve authority.
        return [];
    }
    const group = authority.group.group;
    return resolveGroupLifecycleManagers({
        manager: policy.manager,
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
