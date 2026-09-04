import { isSameGroupLayoutIdentity, type GroupLayoutIdentity } from '../group-layout-identity.ts';
import type { GroupActivationCondition } from './compute-group-activation-condition.ts';
import type { GroupEvidenceWatermark } from './compute-group-formation-reading.ts';

/**
 * One confirmed observation of a group's connectivity, written by internal
 * authority and read by no policy or gate (product decision 3). It is stored
 * whole because every field is decided by the same reading: publishing the
 * condition without the coverage, basis and instant it came from is what
 * makes a status untruthful about its lag.
 *
 * The remediation axis is deliberately absent. Its inputs are transient -- a
 * queued replan drains and a temporary override expires, neither of which
 * writes a status -- so a stored value would be stale far more often than
 * right. It stays derived at read, where those facts are current (I40).
 */
export type GroupActivationStatus = Readonly<{
    /** Coverage of the layout carrying traffic (product decision 30). */
    condition: GroupActivationCondition;
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

/**
 * The watermark's stored key registry lives here rather than beside the
 * computation that produces it: the validators need only these two names, and
 * importing them from the computation drags the whole reading module into
 * every browser bundle that validates a group.
 */
export const GROUP_EVIDENCE_WATERMARK_KEYS = [
    'version',
    'createdAtEpochMs'
] as const satisfies readonly (keyof GroupEvidenceWatermark)[];

/** The runtime key registry the persistence and wire validators check against. */
export const GROUP_ACTIVATION_STATUS_KEYS = [
    'condition',
    'coverageRate',
    'coverageBasisLayoutIdentity',
    'formationEpoch',
    'evidenceWatermark',
    'confirmedAtEpochMs'
] as const satisfies readonly (keyof GroupActivationStatus)[];

/**
 * The causal series a status belongs to (product decision 33). Both halves
 * are needed: a changed basis starts a distinct series, and so does a changed
 * epoch — a hold-landing `reconfigure` from `active` advances the epoch while
 * retaining the accepted layout identity, so a basis comparison alone would
 * carry the spent series' band into the live one.
 */
export type GroupActivationSeries = Readonly<{
    formationEpoch: number;
    coverageBasisLayoutIdentity: GroupLayoutIdentity;
}>;

/** Whether a stored status still describes `series`. */
export function isSameGroupActivationSeries(
    status: GroupActivationSeries,
    series: GroupActivationSeries
): boolean {
    return status.formationEpoch === series.formationEpoch &&
        isSameGroupLayoutIdentity(status.coverageBasisLayoutIdentity, series.coverageBasisLayoutIdentity);
}
