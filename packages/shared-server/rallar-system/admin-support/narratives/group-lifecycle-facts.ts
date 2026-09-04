import type { AdminSupportFact } from '@shared/api/admin-support/admin-support-types.ts';
import { toGroupLayoutIdentity, type GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { Group } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

/**
 * The lifecycle plane an operator actually asks about: which stage the group
 * is in, which series it is on, which layout carries traffic, whether
 * application data is flowing (product decision 25 keeps the valve off the
 * routing plane), and what the group is telling its members about its own
 * connectivity.
 *
 * The status half is derived, non-authoritative state that no policy or gate
 * reads (product decision 3). It is reported as unconfirmed with unavailable
 * certainty until the writer has stored one, rather than inventing a band no
 * clock has observed.
 */
export function groupLifecycleFacts(
    group: Group,
    plannedSnapshot: RallarOverlayTopologySnapshot | null
): readonly AdminSupportFact[] {
    const status = group.activationStatus;
    // A status from a spent series describes a layout the group has moved
    // past. The formation view refuses to publish one; a support surface
    // should still show it -- that staleness is often the thing being
    // debugged -- but must not call it exact.
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
        { label: 'group.transportState', source: 'group-state', value: group.transportState, certainty: 'exact' },
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
            value: plannedSnapshot === null || plannedSnapshot.state !== 'active'
                ? 'none'
                : toLayoutIdentitySummary(toGroupLayoutIdentity(plannedSnapshot)),
            certainty: plannedSnapshot === null ? 'unavailable' : 'exact'
        },
        {
            label: 'group.activationCondition',
            source: 'group-state',
            value: status?.condition ?? 'unconfirmed',
            certainty: statusCertainty
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

/**
 * A layout identity is the tuple, never a bare version (product decision 29),
 * so an operator comparing two of them can tell a re-plan from a re-publish.
 */
function toLayoutIdentitySummary(identity: GroupLayoutIdentity | null): string {
    return identity === null
        ? 'none'
        : `${identity.state} r${identity.groupRevision}/${identity.presenceRevision} v${identity.version}`;
}
