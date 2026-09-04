import type { PendingTopologyReplan } from '../graph-topology-management-types.ts';
import type { GroupRef } from '../group-types.ts';
import type {
    GroupActivationCondition,
    GroupActivationRemediation
} from './activation-status/compute-group-activation-condition.ts';
import type { GroupFormationReadiness } from './activation-status/compute-group-formation-reading.ts';
import type { GroupLayoutIdentity } from './group-layout-identity.ts';
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
     * Product decision 11's latched obligation: the accepted layout no longer
     * matches the planning authority's topology inputs. A temporary topology
     * override is part of those inputs, so its expiry can raise this on
     * wall-clock time alone.
     */
    layoutStale: boolean;
    /** The transient half: a replan is queued and due; null when none is. */
    pending: PendingTopologyReplan | null;
    /**
     * The attempt budget the series is spending, so an application can explain
     * `formation-attempts-exhausted` (product decision 39). The numerator is
     * `formationAttemptCount`; the attempt that reaches this parks the group.
     * Null when the stored policy is unreadable, which is also when no manager
     * resolves -- the read surface claims nothing it cannot read.
     */
    maxFormationAttempts: number | null;
    /**
     * The observed condition of the layout carrying traffic (product decision
     * 30). Reported from the stored status whenever that status still
     * describes the current series, because the dwell-held bands -- `degraded`
     * and below-floor `failed` -- exist only where a clock has observed them.
     * A read with no stored status for this basis derives what it can, which
     * is every band except those two.
     */
    condition: GroupActivationCondition;
    /** Whose move it is, naming only work the server performs. */
    remediation: GroupActivationRemediation;
    /**
     * The layout the condition is measured against: the accepted one whenever
     * one exists, and before first activation the frozen planned candidate
     * being dialed. Null when no layout carries traffic or is being dialed,
     * and null whenever the stored policy is unreadable. A parked group keeps
     * the identity of the layout its spent series ran on, so a non-null basis
     * is not itself a claim that traffic is flowing.
     */
    coverageBasisLayoutIdentity: GroupLayoutIdentity | null;
}>;
