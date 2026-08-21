import type { TuneSourceModel } from './tune-source-model.ts';

/**
 * Returns the React reset boundary for candidate-editing state.
 *
 * Snapshot timestamps are intentionally absent: polling freshness must not
 * discard a draft when its authority, support, identity, and knob truth are
 * unchanged.
 */
export function tuneCandidateFingerprint(
    source: TuneSourceModel,
    knobRevisionKey = tuneKnobRevisionKey(source)
): string {
    const contextKey = JSON.stringify({
        identity: {
            distributedRunId: source.identity.distributedRunId,
            controlRunId: source.identity.controlRunId,
            quarantined: source.identity.quarantined,
            snapshotDistributedRunId: source.distributedRun?.distributedRunId,
            snapshotDistributedControlRunId: source.distributedRun?.controlRunId,
            snapshotControlRunId: source.controlRun?.runId
        },
        support: {
            authority: source.provenance.source,
            detail: source.provenance.detail,
            retainedRelation: source.retained.relation,
            retainedWorkspace: source.retained.support
        }
    });
    return `${contextKey}\u0000${knobRevisionKey}`;
}

function tuneKnobRevisionKey(source: TuneSourceModel): string {
    let revisionKey = 'tune-candidate-knob-fallback-v1:';
    for (const knob of source.inventory?.knobs ?? []) {
        const row = JSON.stringify([
            knob.pointer,
            knob.name,
            knob.scope,
            knob.currentValue,
            knob.availability,
            knob.effective,
            knob.commandId,
            knob.recipeId,
            knob.reason,
            knob.constraint
        ]);
        revisionKey += `${row.length}:${row}`;
    }
    return revisionKey;
}
