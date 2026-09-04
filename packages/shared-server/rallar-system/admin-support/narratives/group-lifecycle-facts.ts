import type { AdminSupportFact } from '@shared/api/admin-support/admin-support-types.ts';
import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { Group } from '@shared/api/group-types.ts';

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
export function groupLifecycleFacts(group: Group): readonly AdminSupportFact[] {
    const status = group.activationStatus;
    const statusCertainty = status === null ? 'unavailable' : 'exact';
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
