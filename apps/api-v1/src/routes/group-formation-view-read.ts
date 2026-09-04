import {
    toReadGroupLifecyclePolicy,
    type GroupLifecyclePolicyRead
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
import {
    isSameGroupLayoutIdentity,
    toGroupLayoutIdentity,
    type GroupLayoutIdentity
} from '@shared/api/group-lifecycle/group-layout-identity.ts';
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
            knownGroup: snapshot
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
    const policy = toReadGroupLifecyclePolicy(policyRead);
    const readiness = toFormationReadiness(view.snapshot, authority);
    const status = computeActivationStatus({
        group,
        policy,
        planned: view.snapshot,
        accepted: view.acceptedSnapshot,
        authority,
        layoutStale,
        replanQueued: view.pending !== null
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

interface ComputeActivationStatusInput {
    readonly group: Group;
    readonly policy: GroupLifecyclePolicy | null;
    readonly planned: RallarOverlayTopologySnapshot | null;
    readonly accepted: RallarOverlayTopologySnapshot | null;
    readonly authority: GroupTopologyPlanningAuthority;
    readonly layoutStale: boolean;
    readonly replanQueued: boolean;
}

interface GroupActivationStatus {
    readonly condition: GroupActivationCondition;
    readonly remediation: GroupActivationRemediation;
    readonly coverageBasisLayoutIdentity: GroupLayoutIdentity | null;
}

/**
 * Both axes at this read (product decision 30). An unreadable policy carries
 * no thresholds and no budget, so it reports no coverage and hands a stale
 * layout to the application -- the same fail-closed answer the manager
 * resolution gives, and the honest one, because a corrupt policy is also what
 * stops the automation from replanning.
 */
function computeActivationStatus(input: ComputeActivationStatusInput): GroupActivationStatus {
    const { group, policy, layoutStale, replanQueued } = input;
    const business = resolveGroupBusinessLiveness(group, input.authority.nowEpochMs);
    const basisSnapshot = resolveCoverageBasisSnapshot(input);
    const attemptBudgetExhausted = policy !== null && isFormationAttemptBudgetExhausted({
        activation: policy.activation,
        formationAttemptCount: group.formationAttemptCount
    });
    return {
        condition: computeGroupActivationCondition({
            business,
            lifecycleState: group.lifecycleState,
            attemptBudgetExhausted,
            coverage: toCoverageObservation(policy, basisSnapshot, input.authority)
        }),
        remediation: resolveGroupActivationRemediation({
            business,
            lifecycleState: group.lifecycleState,
            attemptBudgetExhausted,
            replanning: policy?.topology.replanning ?? 'corrupt',
            layoutStale,
            replanQueued
        }),
        coverageBasisLayoutIdentity: resolveCoverageBasisIdentity(input)
    };
}

/** The basis identity, whether or not its snapshot is loaded here. */
function resolveCoverageBasisIdentity(input: ComputeActivationStatusInput): GroupLayoutIdentity | null {
    if (input.policy === null) {
        return null;
    }
    return resolveCoverageBasisLayoutIdentity({
        lifecycleState: input.group.lifecycleState,
        accepted: input.group.acceptedLayoutIdentity ?? undefined,
        plannedCandidate: isActiveLayoutSnapshot(input.planned)
            ? toGroupLayoutIdentity(input.planned)
            : undefined
    }) ?? null;
}

/**
 * The loaded snapshot the basis names. The condition is measured on that
 * snapshot or not at all: measuring the planned slot while naming the accepted
 * layout reports a number about a layout the group is not carrying traffic on,
 * which a held candidate makes routine. A layout that is not `active` is a
 * tombstone whose empty edge set reads as trivially complete, so it is neither
 * a basis nor a measurement subject -- the criterion path refuses one for the
 * same reason.
 */
function resolveCoverageBasisSnapshot(
    input: ComputeActivationStatusInput
): RallarOverlayTopologySnapshot | undefined {
    const basis = resolveCoverageBasisIdentity(input);
    if (basis === null) {
        return undefined;
    }
    return [input.accepted, input.planned]
        .filter(isActiveLayoutSnapshot)
        .find((snapshot) => isSameGroupLayoutIdentity(toGroupLayoutIdentity(snapshot), basis));
}

function isActiveLayoutSnapshot(
    snapshot: RallarOverlayTopologySnapshot | null
): snapshot is RallarOverlayTopologySnapshot {
    return snapshot !== null && snapshot.state === 'active';
}

/**
 * `dwellSatisfied` is false at every read: the dwell clock belongs to the
 * status writer, so `degraded` and the dwell-held `failed` band are not
 * reported until that slice lands (implementation decision I36).
 */
function toCoverageObservation(
    policy: GroupLifecyclePolicy | null,
    basisSnapshot: RallarOverlayTopologySnapshot | undefined,
    authority: GroupTopologyPlanningAuthority
): GroupCoverageObservation | undefined {
    if (policy === null || basisSnapshot === undefined) {
        return undefined;
    }
    return {
        coverageRate: computeGroupFormationReadiness({
            planned: basisSnapshot,
            rttMeasurements: authority.rttMeasurements,
            nowEpochMs: authority.nowEpochMs
        }).observedRate,
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
