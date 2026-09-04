import type {
    GroupActivationCondition,
    GroupActivationRemediation
} from './compute-group-activation-condition.ts';
import type { GroupEvidenceWatermark } from './compute-group-formation-reading.ts';
import type { GroupLayoutIdentity } from './group-layout-identity.ts';

/**
 * One confirmed observation of a group's connectivity, written by internal
 * authority and read by no policy or gate (product decision 3). It is stored
 * whole because every field is decided by the same reading: publishing the
 * axes without the coverage, basis and instant they came from is what makes a
 * status untruthful about its lag.
 */
export type GroupActivationStatus = Readonly<{
    /** Coverage of the layout carrying traffic (product decision 30). */
    condition: GroupActivationCondition;
    /** Whose move it is, naming only work the server performs. */
    remediation: GroupActivationRemediation;
    /** The coverage fraction this condition was banded from. */
    coverageRate: number;
    /**
     * The layout the coverage was measured against: the accepted one whenever
     * one exists, and before first activation the frozen planned candidate
     * being dialed. With `formationEpoch` it names the causal series
     * (product decision 33); two successive initial planned identities
     * therefore cannot share one series.
     */
    coverageBasisLayoutIdentity: GroupLayoutIdentity;
    /**
     * The epoch this status was computed under, which is not always the
     * group's current one: a transition can advance the group past a status
     * still on the row, and a status from a spent series must not be compared
     * with a watermark from the live one.
     */
    formationEpoch: number;
    /**
     * The newest evidence this status decided on, or null when the reading
     * counted none. A write must strictly advance it within one series
     * (product decision 33); the durable clocks write without one, because a
     * decay that is the absence of evidence can never advance a watermark.
     */
    evidenceWatermark: GroupEvidenceWatermark | null;
    /**
     * When this status was last confirmed -- not when it last changed. A
     * status that is still true stays on the row with a newer instant, which
     * is what lets a reader tell "still active" from "last seen active".
     */
    confirmedAtEpochMs: number;
}>;

/** The runtime key registry the persistence and wire validators check against. */
export const GROUP_ACTIVATION_STATUS_KEYS = [
    'condition',
    'remediation',
    'coverageRate',
    'coverageBasisLayoutIdentity',
    'formationEpoch',
    'evidenceWatermark',
    'confirmedAtEpochMs'
] as const satisfies readonly (keyof GroupActivationStatus)[];
