import { Temporal } from '@js-temporal/polyfill';

import {
    AL_FIRST_GAP_RENEWAL_REQUEST_NUMBER,
    AL_MESSAGE_RESOURCE_LIMITS
} from '../../../al-contracts/al-message-resource-limits.ts';
import type { ALOrderingObservation, ALOrderingTrackSnapshot, ALSeqRange } from '../../../al-contracts/al-runtime.ts';
import { computeALOrderingMissingRanges } from '../../compute-al-ordering-observation.ts';
import type {
    ALInboundCommitBundle,
    ALInboundGapRenewalEffect,
    ALInboundMessageReadDto
} from '../al-inbound-admission-store.ts';
import { toALInboundMessageReference } from '../al-inbound-canonical-message.ts';
import type { ALInboundEffectIntent } from '../al-inbound-effect-intent.ts';
import { toALInboundEffectId, type ALInboundDurableEffectWrite } from '../al-inbound-work-entry.ts';
import {
    isALInboundCountedSelf,
    isALInboundRecipientReceiptIntent
} from '../receipt-proof/is-al-inbound-recipient-receipt.ts';

/** The gap NACK an admission planned for an arrival that revealed a gap. */
export type ALInboundGapNackIntent = ALInboundEffectIntent & {
    readonly payload: Extract<ALInboundEffectIntent['payload'], { readonly kind: 'send-nack'; }>;
};

export interface ToALInboundGapRenewalEffectsInput {
    readonly read: ALInboundMessageReadDto;
    /** The admission's own gap NACK; absent when it planned none, and then it arms nothing. */
    readonly gapNack: ALInboundGapNackIntent | undefined;
    /** The receiving peer, whose gap NACK the renewal's signing rule is read from. */
    readonly selfPeerId: string;
}

/**
 * The ranges this arrival reveals missing for the first time: those above everything the track already held, since
 * every lower missing sequence was revealed by the arrival that first passed it and has its own timer.
 */
export function computeALInboundNewlyMissingRanges(
    previous: ALOrderingTrackSnapshot | undefined,
    observation: ALOrderingObservation
): readonly ALSeqRange[] {
    if (observation.status !== 'gap') {
        return [];
    }
    const heldThrough = Math.max(previous?.lastContiguousSeq ?? 0, ...(previous?.bufferedSeqs ?? []));
    return observation.missingRanges.flatMap((range) =>
        range.to <= heldThrough ? [] : [{ from: Math.max(range.from, heldThrough + 1), to: range.to }]
    );
}

/** The runs of `range` the track has neither passed nor buffered; none without a live track. */
export function computeALInboundStillMissingRanges(
    range: ALSeqRange,
    position: Pick<ALOrderingTrackSnapshot, 'lastContiguousSeq' | 'bufferedSeqs'> | undefined
): readonly ALSeqRange[] {
    return position === undefined ? [] : computeALOrderingMissingRanges(
        Math.max(range.from, position.lastContiguousSeq + 1),
        range.to + 1,
        new Set(position.bufferedSeqs)
    );
}

/** The factor this receiver stretches every renewal interval by, between 1 and the most a stretch may be. */
export function computeALGapRenewalStretch(random: () => number): number {
    return 1 + (AL_MESSAGE_RESOURCE_LIMITS.gapRenewalMaxStretch - 1) * random();
}

/** How long the request numbered `requestNumber` waits after the one before it; none past the last interval. */
export function computeALGapRenewalDelayMs(requestNumber: number, stretch: number): number | undefined {
    const intervalMs: number | undefined =
        AL_MESSAGE_RESOURCE_LIMITS.gapRenewalIntervalsMs[requestNumber - AL_FIRST_GAP_RENEWAL_REQUEST_NUMBER];
    return intervalMs === undefined ? undefined : Math.ceil(intervalMs * stretch);
}

export function toALInboundGapRenewalEffectId(payload: ALInboundGapRenewalEffect): string {
    const { trackKey, range, requestNumber, message } = payload;
    return toALInboundEffectId(['renew-gap', trackKey, range.from, range.to, requestNumber, message.msgId]);
}

export function isALInboundGapNackIntent(intent: ALInboundEffectIntent): intent is ALInboundGapNackIntent {
    return intent.payload.kind === 'send-nack' && intent.payload.reason === 'gap';
}

/** One timer per range an admitted gap reveals, toward the peer its gap NACK goes to and expiring with that NACK. */
export function toALInboundGapRenewalEffects(
    input: ToALInboundGapRenewalEffectsInput
): readonly ALInboundEffectIntent[] {
    const { read, gapNack } = input;
    const trackKey = read.plan.orderingRuntime.trackKey;
    if (gapNack === undefined || trackKey === undefined) {
        return [];
    }
    const { toPeerId } = gapNack.payload;
    const countsSelf = isALInboundCountedSelf(read.msg, read.plan, input.selfPeerId);
    return computeALInboundNewlyMissingRanges(read.orderingSnapshot, read.plan.orderingRuntime).map((range) => {
        const payload: ALInboundGapRenewalEffect = {
            kind: 'renew-gap',
            trackKey,
            range,
            requestNumber: AL_FIRST_GAP_RENEWAL_REQUEST_NUMBER,
            toPeerId,
            message: toALInboundMessageReference(read.msg),
            traceId: read.msg.id.traceId,
            signsForRecipient: isALInboundRecipientReceiptIntent(gapNack, countsSelf)
        };
        return {
            effectId: toALInboundGapRenewalEffectId(payload),
            expireAtTimestamp: gapNack.expireAtTimestamp,
            carrier: gapNack.carrier,
            payload
        };
    });
}

/** The same row, first claimable at `dueAtMs`. */
export function toALInboundWorkEntryDueAt(
    write: ALInboundDurableEffectWrite,
    dueAtMs: number
): ALInboundDurableEffectWrite {
    const { entry } = write;
    return {
        ...write,
        entry: {
            ...entry,
            dequeueAudit: { ...entry.dequeueAudit, nextTs: Temporal.Instant.fromEpochMilliseconds(dueAtMs) }
        }
    };
}

/** Each timer the bundle writes, due its request's interval after `armedAtMs`. */
export function toALInboundGapRenewalsDueAt(
    bundle: ALInboundCommitBundle,
    armedAtMs: number,
    stretch: number
): ALInboundCommitBundle {
    return {
        ...bundle,
        durableEffects: bundle.durableEffects.flatMap((effect) => {
            if (effect.payload.kind !== 'renew-gap') {
                return [effect];
            }
            const delayMs = computeALGapRenewalDelayMs(effect.payload.requestNumber, stretch);
            return delayMs === undefined ? [] : [toALInboundWorkEntryDueAt(effect, armedAtMs + delayMs)];
        })
    };
}
