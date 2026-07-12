import type { TuneSourceModel } from './tune-source-model.ts';

/**
 * Returns the React reset boundary for candidate-editing state.
 *
 * Snapshot timestamps are intentionally absent: polling freshness must not
 * discard a draft when its authority, support, identity, and knob truth are
 * unchanged.
 */
export function tuneCandidateFingerprint(source: TuneSourceModel): string {
    const knobs = (source.inventory?.knobs ?? [])
        .map(knob => ({
            pointer: knob.pointer,
            currentValue: knob.currentValue,
            availability: knob.availability,
            effective: knob.effective,
        }))
        .sort((left, right) => left.pointer.localeCompare(right.pointer));

    return JSON.stringify({
        identity: {
            distributedRunId: source.identity.distributedRunId,
            controlRunId: source.identity.controlRunId,
            quarantined: source.identity.quarantined,
            snapshotDistributedRunId: source.distributedRun?.distributedRunId,
            snapshotDistributedControlRunId: source.distributedRun?.controlRunId,
            snapshotControlRunId: source.controlRun?.runId,
        },
        support: {
            authority: source.provenance.source,
            detail: source.provenance.detail,
            retainedRelation: source.retained.relation,
            retainedWorkspace: source.retained.support,
        },
        knobs,
    });
}
