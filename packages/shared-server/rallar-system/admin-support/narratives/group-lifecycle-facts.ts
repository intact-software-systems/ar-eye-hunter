import type { AdminSupportFact } from '@shared/api/admin-support/admin-support-types.ts';
import {
    resolveGroupActivationRemediation,
    resolveGroupBusinessLiveness
} from '@shared/api/group-lifecycle/activation-status/compute-group-activation-condition.ts';
import { computeGroupDataGate } from '@shared/api/group-lifecycle/compute-group-data-gate.ts';
import {
    isSameGroupLayoutIdentity,
    toGroupLayoutIdentity,
    type GroupLayoutIdentity
} from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { GroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import { isFormationAttemptBudgetExhausted } from '@shared/api/group-lifecycle/group-lifecycle-transitions.ts';
import type { Group } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

export interface GroupLifecycleFactsInput {
    readonly group: Group;
    readonly plannedSnapshot: RallarOverlayTopologySnapshot | null;
    readonly acceptedSnapshot: RallarOverlayTopologySnapshot | null;
    readonly replanQueued: boolean;
    readonly policy: GroupLifecyclePolicy | null;
    readonly nowEpochMs: number;
}

/**
 * The lifecycle plane, for an operator.
 *
 * The status half is derived, non-authoritative state that no policy or gate
 * reads (product decision 3). It is reported as stored rather than recomputed,
 * because a stale band is often the thing being debugged -- but a status from
 * a series the group has left is marked `inferred` rather than `exact`, and
 * carries the epoch and instant that make the staleness checkable.
 */
export function groupLifecycleFacts(input: GroupLifecycleFactsInput): readonly AdminSupportFact[] {
    const { group, policy } = input;
    const status = group.activationStatus;
    const statusCertainty = status === null
        ? 'unavailable'
        : status.formationEpoch === group.formationEpoch
        ? 'exact'
        : 'inferred';
    return [
        { label: 'group.lifecycleState', source: 'group-state', value: group.lifecycleState, certainty: 'exact' },
        { label: 'group.formationEpoch', source: 'group-state', value: group.formationEpoch, certainty: 'exact' },
        {
            label: 'group.formationAttemptCount',
            source: 'group-state',
            value: group.formationAttemptCount,
            certainty: 'exact'
        },
        {
            // The denominator, so a live group's distance from exhaustion is
            // visible rather than inferred from the numerator alone.
            label: 'group.maxFormationAttempts',
            source: 'group-lifecycle-policy',
            value: policy?.activation.maxFormationAttempts ?? 'unreadable',
            certainty: policy === null ? 'unavailable' : 'exact'
        },
        { label: 'group.transportState', source: 'group-state', value: group.transportState, certainty: 'exact' },
        {
            // The valve is only half the gate: the forward gate composes with
            // it under `blocked-until-active` (product decision 25), so
            // `flowing` alone does not mean application data flows.
            label: 'group.dataGate',
            source: 'group-lifecycle-policy',
            value: policy === null ? 'unreadable' : computeGroupDataGate({
                lifecycleState: group.lifecycleState,
                transportState: group.transportState,
                preActivationAppData: policy.data.preActivationAppData
            }),
            certainty: policy === null ? 'unavailable' : 'exact'
        },
        {
            label: 'group.acceptedLayoutIdentity',
            source: 'group-state',
            value: toLayoutIdentitySummary(group.acceptedLayoutIdentity),
            certainty: group.acceptedLayoutIdentity === null ? 'unavailable' : 'exact'
        },
        {
            // The candidate waiting to be dialed. A held one sitting beside a
            // different accepted identity is what a `hold` reconfigure landing
            // looks like, and it is otherwise invisible to an operator.
            label: 'group.plannedLayoutIdentity',
            source: 'group-topology',
            value: toLayoutIdentitySummary(toActiveLayoutIdentity(input.plannedSnapshot)),
            certainty: input.plannedSnapshot === null ? 'unavailable' : 'exact'
        },
        {
            label: 'group.activationCondition',
            source: 'group-state',
            value: status?.condition ?? 'unconfirmed',
            certainty: statusCertainty
        },
        {
            label: 'group.activationRemediation',
            source: 'group-lifecycle-policy',
            value: policy === null ? 'unreadable' : resolveGroupActivationRemediation({
                business: resolveGroupBusinessLiveness(group, input.nowEpochMs),
                lifecycleState: group.lifecycleState,
                attemptBudgetExhausted: isFormationAttemptBudgetExhausted({
                    activation: policy.activation,
                    formationAttemptCount: group.formationAttemptCount
                }),
                replanQueued: input.replanQueued,
                layoutStale: toIdentityLayoutStale(input),
                replanning: policy.topology.replanning
            }),
            // The staleness input is the identity half of `computeLayoutStale`
            // only: this surface has no planning fingerprint, so a layout that
            // is stale solely because its topology inputs moved -- an expired
            // temporary override, say -- reads as current here.
            certainty: policy === null ? 'unavailable' : 'inferred'
        },
        {
            label: 'group.activationCoverageRate',
            source: 'group-state',
            value: status?.coverageRate ?? 'unconfirmed',
            certainty: statusCertainty
        },
        {
            label: 'group.activationCoverageBasis',
            source: 'group-state',
            value: toLayoutIdentitySummary(status?.coverageBasisLayoutIdentity ?? null),
            certainty: statusCertainty
        },
        {
            label: 'group.activationStatusEpoch',
            source: 'group-state',
            value: status?.formationEpoch ?? 'unconfirmed',
            certainty: statusCertainty
        },
        {
            label: 'group.activationConfirmedAtEpochMs',
            source: 'group-state',
            value: status?.confirmedAtEpochMs ?? 'unconfirmed',
            certainty: statusCertainty
        }
    ];
}

/** True when the series is spent, which is what denies a fresh `start`. */
export function isGroupFormationSeriesParked(group: Group, policy: GroupLifecyclePolicy | null): boolean {
    return group.lifecycleState === 'dormant' &&
        policy !== null &&
        isFormationAttemptBudgetExhausted({
            activation: policy.activation,
            formationAttemptCount: group.formationAttemptCount
        });
}

/**
 * The identity half of `computeLayoutStale`, which is all this surface can
 * answer: it decides the accepted-versus-planned comparison exactly and
 * cannot see the planning fingerprint, so it passes equal fingerprints and
 * under-reports staleness rather than inventing it.
 */
function toIdentityLayoutStale(input: GroupLifecycleFactsInput): boolean {
    const accepted = input.group.acceptedLayoutIdentity;
    if (accepted === null) {
        return false;
    }
    const planned = toActiveLayoutIdentity(input.plannedSnapshot);
    return planned === null || !isSameGroupLayoutIdentity(accepted, planned);
}

function toActiveLayoutIdentity(snapshot: RallarOverlayTopologySnapshot | null): GroupLayoutIdentity | null {
    return snapshot === null || snapshot.state !== 'active' ? null : toGroupLayoutIdentity(snapshot);
}

/**
 * A layout identity is the tuple, never a bare version (product decision 29),
 * so an operator comparing two of them can tell a re-plan from a re-publish.
 */
function toLayoutIdentitySummary(identity: GroupLayoutIdentity | null): string {
    return identity === null
        ? 'none'
        : `${identity.state} r${identity.groupRevision}/${identity.presenceRevision} v${identity.version}`;
}
