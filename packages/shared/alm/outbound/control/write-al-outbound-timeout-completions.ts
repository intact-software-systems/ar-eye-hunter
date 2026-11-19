import { EntityStatus } from '../../../queuebox/ResourceEntry.ts';
import type { ALAdmissionWorkWriteContext } from '../../al-admission-work-backend.ts';
import type { ALOutboundPendingAckSnapshot } from '../../al-runtime-state-stores.ts';
import { toALOutboundWorkKey } from '../al-outbound-work-entry.ts';
import type { ALOutboundFirstHopWaitSnapshot } from '../first-hop/compute-al-outbound-first-hop-wait.ts';
import {
    toALOutboundAckTimeoutEffectId,
    toALOutboundFirstHopTimeoutEffectId
} from '../to-al-outbound-effect-id.ts';

/** The current timers of the receipt and the first-hop wait a commit ends; each is given only when that commit ends it. */
export function toALOutboundEndedTimeoutEffectIds(
    endedReceipt: ALOutboundPendingAckSnapshot | undefined,
    endedWait: ALOutboundFirstHopWaitSnapshot | undefined
): readonly string[] {
    return [
        ...(endedReceipt === undefined ? [] : [toALOutboundAckTimeoutEffectId(endedReceipt)]),
        ...(endedWait === undefined ? [] : [toALOutboundFirstHopTimeoutEffectId(endedWait)])
    ];
}

/**
 * Completes each waiting timer of a receipt or a first-hop wait this commit ends: left pending, it would find nothing
 * to retry at its deadline, and until then it holds a slot of the key-ordered claim page. The deadline batch it
 * replaces also cleared a complete receipt row; that row now waits for its expiry, which every reader treats as ended.
 * A timer a batch already leased is left to that batch, which finds what it waited on ended.
 */
export async function writeALOutboundTimeoutCompletions(
    tx: ALAdmissionWorkWriteContext,
    namespace: string,
    effectIds: readonly string[]
): Promise<void> {
    for (const effectId of effectIds) {
        const entry = await tx.readWork(toALOutboundWorkKey(namespace, effectId));
        if (entry?.status === EntityStatus.NEW || entry?.status === EntityStatus.RETRY) {
            tx.writeWork({ ...entry, status: EntityStatus.COMPLETED });
        }
    }
}
