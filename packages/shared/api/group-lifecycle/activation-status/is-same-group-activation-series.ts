import { isSameGroupLayoutIdentity, type GroupLayoutIdentity } from '../group-layout-identity.ts';

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
