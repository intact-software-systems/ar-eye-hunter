import { NonRetryableException } from '../../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import type { ResourceEntry } from '../../../queuebox/ResourceEntry.ts';
import { ALAdmissionCorruptionError } from '../../al-admission-decoder.ts';
import type { ALWorkClaimResult } from '../../work/al-work-handler.ts';
import type { ALWorkClaim, ALWorkQueuePort } from '../../work/al-work-queue-port.ts';
import { resolveALWorkEntryReadyAt } from '../../work/read-al-work-ready-at.ts';
import type { ALInboundAdmissionStore } from '../al-inbound-admission-store.ts';
import type { ALInboundAdmittedDelivery } from '../al-inbound-admitted-delivery.ts';
import type { ALInboundOrderedDelivery } from '../al-inbound-ordered-delivery.ts';
import {
    AL_INBOUND_WORK_LEASE_MS,
    decodeALInboundWorkEntry,
    toALInboundWorkKey,
    toALInboundWorkType
} from '../al-inbound-work-entry.ts';

export namespace ClaimALInboundOrderedSuccessor {
    export interface Input {
        readonly port: ALWorkQueuePort;
        /** Where the delivery the batch just completed left its track. */
        readonly position: ALInboundOrderedDelivery.Position;
        readonly admissionStore: Pick<ALInboundAdmissionStore, 'readOrderedSuccessor'>;
        readonly delivery: ALInboundAdmittedDelivery;
        readonly namespace: string;
        readonly nowMs: number;
    }

    /** The claim the port reserved, and the effect id the page's deferred rows may list it under. */
    export interface Claimed {
        readonly claim: ALWorkClaim;
        readonly effectId: string;
    }
}

/**
 * The successor a completed delivery hands its place in the batch to (D190, D785): the delivery row, a dispatch or a
 * release, that the track's slot after the position names, read by that slot rather than looked for on a page, since a
 * page holds its rows in queue order and a track's next delivery is as often on the page after it. It is claimed only
 * when it is this lane's, due, and its delivery reads it ready now that the predecessor is delivered, and only as that
 * read observed it, so a track never has two deliveries claimed at once. A hand-on that loses that race claims nothing
 * and leaves the row to the rotation.
 */
export async function claimALInboundOrderedSuccessor(
    input: ClaimALInboundOrderedSuccessor.Input
): Promise<ClaimALInboundOrderedSuccessor.Claimed | undefined> {
    const { trackKey, completedThrough } = input.position;
    const successor = await input.admissionStore.readOrderedSuccessor(trackKey, completedThrough);
    if (
        successor === undefined ||
        !input.port.workTypes.has(toALInboundWorkType(input.namespace, successor.carrier))
    ) {
        return undefined;
    }
    const entry = await input.port.readEntry(toALInboundWorkKey(input.namespace, successor.effectId));
    if (entry === undefined || !await isALInboundSuccessorClaimableNow(entry, input)) {
        return undefined;
    }
    const [claim] = await input.port.claimObserved([entry]);
    return claim === undefined ? undefined : { claim, effectId: successor.effectId };
}

/** A delivery that completed on a track names its position as its claim's succession; any other answer is its outcome. */
export function toALInboundSuccessionResult(
    completion: ALInboundOrderedDelivery.Completion
): ALWorkClaimResult<ALInboundOrderedDelivery.Position> {
    if (completion === 'retry') {
        return { status: 'retry' };
    }
    return completion.position === undefined
        ? { status: 'completed' }
        : { status: 'completed-with-succession', succession: completion.position };
}

/** A row that cannot be decoded or delivered is left to the rotation, whose page claims it to reject it. */
async function isALInboundSuccessorClaimableNow(
    entry: ResourceEntry,
    input: ClaimALInboundOrderedSuccessor.Input
): Promise<boolean> {
    if (
        entry.audit.expiryTs.epochMilliseconds <= input.nowMs ||
        resolveALWorkEntryReadyAt(entry, AL_INBOUND_WORK_LEASE_MS) > input.nowMs
    ) {
        return false;
    }
    try {
        const effect = decodeALInboundWorkEntry(entry, input.namespace);
        return (await input.delivery.readReadiness(effect, input.nowMs)).ready;
    }
    catch (error) {
        if (error instanceof ALAdmissionCorruptionError || error instanceof NonRetryableException) {
            return false;
        }
        throw error;
    }
}
