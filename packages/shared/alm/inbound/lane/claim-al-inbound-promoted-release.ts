import { NonRetryableException } from '../../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import type { ResourceEntry } from '../../../queuebox/ResourceEntry.ts';
import { ALAdmissionCorruptionError } from '../../al-admission-decoder.ts';
import type { ALWorkClaim, ALWorkQueuePort } from '../../work/al-work-queue-port.ts';
import type { ALInboundAdmittedDelivery } from '../al-inbound-admitted-delivery.ts';
import { toALInboundReleaseEffectId } from '../al-inbound-effect-intent.ts';
import { decodeALInboundWorkEntry, resolveALInboundWorkReadyAt, toALInboundWorkKey } from '../al-inbound-work-entry.ts';

export namespace ClaimALInboundPromotedRelease {
    export interface Input {
        readonly port: ALWorkQueuePort;
        /** The claim the batch just completed; only a buffered release promotes anything. */
        readonly completed: ALWorkClaim;
        readonly delivery: ALInboundAdmittedDelivery;
        readonly namespace: string;
        readonly nowMs: number;
    }

    /** The claim the port reserved, and the effect id the page's deferred rows may list it under. */
    export interface Promoted {
        readonly claim: ALWorkClaim;
        readonly effectId: string;
    }
}

/**
 * The successor a completed release promotes (D190): the same track's next release, read by its own
 * key rather than looked for on the page, since a page holds its rows in queue order and a track's
 * next release is as often on the page after it. It is claimed only when it is due and its delivery
 * reads it ready now that the predecessor is delivered, and only as that read observed it, so a
 * track never has two releases claimed at once.
 */
export async function claimALInboundPromotedRelease(
    input: ClaimALInboundPromotedRelease.Input
): Promise<ClaimALInboundPromotedRelease.Promoted | undefined> {
    const payload = decodeALInboundWorkEntry(input.completed.entry, input.namespace).payload;
    if (payload.kind !== 'release-buffered') {
        return undefined;
    }
    const effectId = toALInboundReleaseEffectId(payload.trackKey, payload.seq + 1);
    const entry = await input.port.readEntry(toALInboundWorkKey(input.namespace, effectId));
    if (entry === undefined || !await isALInboundReleaseClaimableNow(entry, input)) {
        return undefined;
    }
    const [claim] = await input.port.claim({ maxCount: 1, observedEntries: [entry] });
    return claim === undefined ? undefined : { claim, effectId };
}

/** A row that cannot be decoded or delivered is left to the rotation, whose page claims it to reject it. */
async function isALInboundReleaseClaimableNow(
    entry: ResourceEntry,
    input: ClaimALInboundPromotedRelease.Input
): Promise<boolean> {
    if (entry.audit.expiryTs.epochMilliseconds <= input.nowMs || resolveALInboundWorkReadyAt(entry) > input.nowMs) {
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
