import { toKeyAsString } from '../../../queuebox/ResourceEntry.ts';
import { AL_WORK_UNDESCRIBED_COMMIT, type ALWorkCommittedRows } from '../../work/al-work-readiness-memory.ts';
import type { ALOutboundDispatchAdmission } from '../al-outbound-dispatch-admission.ts';
import { toALOutboundWorkKey } from '../al-outbound-work-entry.ts';

/** A commit that landed, or a pending admission that wrote its replay work, wrote rows its owner must run. */
export function hasWrittenWork<TPrepared>(result: ALOutboundDispatchAdmission.Result<TPrepared>): boolean {
    return result.committed || result.computed.verdict.kind === 'pending';
}

/**
 * The work rows these commits wrote, as their batch must account for them, or an undescribed commit
 * when one of them wrote work its result does not describe. A receipted send's acknowledgement
 * timeout is due after its send, so the batch that sends it cannot have claimed it.
 */
export function computeALOutboundCommittedRows<TPrepared>(
    namespace: string,
    results: readonly ALOutboundDispatchAdmission.Result<TPrepared>[]
): ALWorkCommittedRows {
    let dueByMs = 0;
    const writtenKeys: string[] = [];
    for (const result of results.filter(hasWrittenWork)) {
        const effects = result.committed ? result.computed.bundle?.durableEffects : undefined;
        if (effects === undefined) {
            return AL_WORK_UNDESCRIBED_COMMIT;
        }
        for (const { effectId, retryAtMs } of effects) {
            if (retryAtMs === undefined) {
                return AL_WORK_UNDESCRIBED_COMMIT;
            }
            dueByMs = Math.max(dueByMs, retryAtMs);
            writtenKeys.push(toKeyAsString(toALOutboundWorkKey(namespace, effectId)));
        }
    }
    return { dueByMs, writtenKeys };
}

/**
 * What settled commits owe their owner's batch: nothing when none wrote work, and an undescribed commit when a
 * member threw, since it ran after the members before it, whose writes may have landed.
 */
export function computeALOutboundSettledCommittedRows<TPrepared>(
    namespace: string,
    outcomes: readonly PromiseSettledResult<ALOutboundDispatchAdmission.Result<TPrepared>>[]
): ALWorkCommittedRows | undefined {
    const results = outcomes.flatMap((outcome) => outcome.status === 'fulfilled' ? [outcome.value] : []);
    if (results.length < outcomes.length) {
        return AL_WORK_UNDESCRIBED_COMMIT;
    }
    return results.some(hasWrittenWork) ? computeALOutboundCommittedRows(namespace, results) : undefined;
}
