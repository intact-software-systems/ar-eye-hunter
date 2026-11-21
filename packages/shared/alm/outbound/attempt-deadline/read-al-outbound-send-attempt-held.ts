import type { ALOutboundAdmissionStore } from '../admission/al-outbound-admission-store.ts';
import { isPendingALOutboundWork, toALOutboundWorkKey } from '../al-outbound-work-entry.ts';
import {
    toALOutboundAttemptSendEffectIds,
    type ALOutboundPlannedSendAttempt
} from '../to-al-outbound-effect-id.ts';

/**
 * Whether no copy of an attempt has been handed to its carrier: the attempt is planned with at least one copy and
 * every copy's send row is still pending. The copies are read in order, and the read stops at the first that is not.
 */
export async function readALOutboundSendAttemptHeld<TPrepared>(
    admissionStore: Pick<ALOutboundAdmissionStore<TPrepared>, 'namespace' | 'readWork'>,
    attempt: ALOutboundPlannedSendAttempt<TPrepared>
): Promise<boolean> {
    const effectIds = toALOutboundAttemptSendEffectIds(attempt);
    for (const effectId of effectIds) {
        const row = await admissionStore.readWork(toALOutboundWorkKey(admissionStore.namespace, effectId));
        if (row === undefined || !isPendingALOutboundWork(row)) {
            return false;
        }
    }
    return effectIds.length > 0;
}
