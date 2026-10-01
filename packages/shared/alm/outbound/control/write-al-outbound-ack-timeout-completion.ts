import { EntityStatus } from '../../../queuebox/ResourceEntry.ts';
import type { ALAdmissionWorkWriteContext } from '../../al-admission-work-backend.ts';
import { toALOutboundWorkKey } from '../al-outbound-work-entry.ts';

/**
 * Completes the waiting timeout check of a receipt this commit ends: left pending, it would find nothing to retry at
 * its deadline, and until then it holds a slot of the key-ordered claim page. The deadline batch it replaces also
 * cleared a complete receipt row; that row now waits for its expiry, which every reader treats as ended. A check a
 * batch already leased is left to that batch.
 */
export async function writeALOutboundAckTimeoutCompletion(
    tx: ALAdmissionWorkWriteContext,
    namespace: string,
    effectId: string
): Promise<void> {
    const entry = await tx.readWork(toALOutboundWorkKey(namespace, effectId));
    if (entry?.status === EntityStatus.NEW || entry?.status === EntityStatus.RETRY) {
        tx.writeWork({ ...entry, status: EntityStatus.COMPLETED });
    }
}
