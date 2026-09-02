import type { PendingTopologyReplan } from '../graph-topology-management-types.ts';
import type { GroupRef } from '../group-types.ts';
import type { GroupFormationReadiness } from './compute-group-formation-readiness.ts';
import type { GroupFormationOutcome, GroupLifecycleState } from './group-lifecycle-policy.ts';

/**
 * The formation read surface: enough for an application to explain the group
 * to a user -- authoritative intent beside derived observation. The readiness
 * fraction is computed at read time and never stored; `lastFormationOutcome`
 * is the recorded decision from the criterion's last evaluation.
 */
export type GroupFormationView = Readonly<{
    groupRef: GroupRef;
    lifecycleState: GroupLifecycleState;
    formationEpoch: number;
    formationAttemptCount: number;
    lastFormationOutcome: GroupFormationOutcome | null;
    establishmentStartedAtEpochMs: number | null;
    readiness: GroupFormationReadiness;
    /**
     * The managers resolved from the policy and the epoch-pinned electorate at
     * read time -- who may command manager-gated actions right now. Empty when
     * the policy selects none or no candidate survives the liveness filter.
     */
    managerPrincipalIds: readonly string[];
    /**
     * The latched staleness obligation (product decision 11): the accepted
     * layout's stored topology-input fingerprint differs from the planning
     * authority's. Under `commanded` replanning it clears only through
     * `reconfigure`. A temporary topology override is part of the authority,
     * so its expiry can raise this on wall-clock time alone.
     */
    layoutStale: boolean;
    /** The transient half: a replan is queued and due; null when none is. */
    pending: PendingTopologyReplan | null;
}>;
