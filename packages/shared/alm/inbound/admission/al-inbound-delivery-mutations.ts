import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import {
    resolveALMessageExpireAtMs,
    type ALDedupAlgo,
    type ALDedupOptions,
    type ALEffectiveAlgorithm
} from '../../../al-contracts/al-policy.ts';
import { resolveExpireAtTimestampWithFallback } from '../../ALStoreRetention.ts';
import { computeALReceiptRetentionExpiryMs } from '../../delivery/compute-al-receipt-retention-expiry-ms.ts';
import type {
    ALInboundAdmissionMutation,
    ALInboundBufferedReleaseReadDto,
    ALInboundMessageReadDto
} from '../al-inbound-admission-store.ts';
import { toALDeliveryCarrier } from '../al-inbound-source-validation.ts';

export interface ComputeALInboundDedupExpiryInput {
    readonly nowMs: number;
    readonly dedup: ALEffectiveAlgorithm<ALDedupAlgo, ALDedupOptions>;
    /** The message's own deadline; undefined when it names none, which keeps the window. */
    readonly messageDeadlineAtMs: number | undefined;
    readonly msgOwnerTtlMs: number;
}

/** The provenance, ordering, dedup and claim rows an admitted message owns; its claim lasts as long as the message. */
export function toALInboundAdmittedMessageMutations(
    read: ALInboundMessageReadDto
): readonly ALInboundAdmissionMutation[] {
    const messageDeadlineAtMs = resolveALMessageExpireAtMs(read.msg, read.plan.effective);
    const deadlineAtMs = messageDeadlineAtMs ?? read.nowMs + read.retention.durableEffectTtlMs;
    const mutations: ALInboundAdmissionMutation[] = [
        {
            kind: 'set-msg-owner',
            value: {
                msgId: read.msg.id.msgId,
                senderId: read.msg.id.senderId,
                source: read.source,
                supersedenceKey: read.plan.supersedence.key ?? null
            },
            expireAtTimestamp: computeALInboundMessageOwnerExpiryMs(read, deadlineAtMs)
        }
    ];
    if (read.orderingAcceptance.observation.trackKey && read.orderingAcceptance.nextSnapshot) {
        mutations.push({
            kind: 'set-ordering',
            trackKey: read.orderingAcceptance.observation.trackKey,
            snapshot: read.orderingAcceptance.nextSnapshot
        });
    }
    mutations.push({
        kind: 'set-dedup',
        dedupKey: read.plan.dedupKey,
        expireAtTimestamp: computeALInboundDedupExpiryMs({
            nowMs: read.nowMs,
            dedup: read.plan.effective.dedup,
            messageDeadlineAtMs,
            msgOwnerTtlMs: read.retention.msgOwnerTtlMs
        })
    });
    if (read.observations.claim !== undefined) {
        mutations.push({
            kind: 'set-claim',
            claimKey: read.observations.claim.key,
            holderPeerId: read.fromPeerId,
            expireAtTimestamp: deadlineAtMs
        });
    }
    return mutations;
}

export function computeALInboundMessageOwnerExpiryMs(
    read: ALInboundMessageReadDto | ALInboundBufferedReleaseReadDto,
    deadlineAtMs: number
): number {
    return read.durability === 'volatile'
        ? computeALReceiptRetentionExpiryMs(deadlineAtMs)
        : read.nowMs + read.retention.msgOwnerTtlMs;
}

/**
 * Held to the deadline, a semantic key would drop new messages that share it, so only identity dedup
 * outlives the window; the message-owner lifetime caps the deadline term.
 */
export function computeALInboundDedupExpiryMs(input: ComputeALInboundDedupExpiryInput): number {
    const windowExpiryMs = input.nowMs + Math.max(0, input.dedup.opts.windowMs);
    if (input.dedup.algo === 'semantic-key' || input.messageDeadlineAtMs === undefined) {
        return windowExpiryMs;
    }
    const deadlineExpiryMs = Math.min(
        computeALReceiptRetentionExpiryMs(input.messageDeadlineAtMs),
        input.nowMs + input.msgOwnerTtlMs
    );
    return Math.max(windowExpiryMs, deadlineExpiryMs);
}

/** The buffered ordered-message slot, plus the older superseded slots this message replaces. */
export function toALInboundDeliveryMutations(
    read: ALInboundMessageReadDto
): readonly ALInboundAdmissionMutation[] {
    const plan = read.plan;
    const mutations = plan.localDelivery.deferred
        ? []
        : [...toALInboundSupersedenceMutations(read.supersedenceAcceptance, plan.supersedence.key)];
    if (
        (!plan.localDelivery.enabled && !plan.localDelivery.deferred) ||
        plan.orderingRuntime.trackKey === undefined || plan.orderingRuntime.seq === undefined
    ) {
        return mutations;
    }
    if (plan.localDelivery.deferred && plan.supersedence.enabled && plan.supersedence.key) {
        for (const buffered of read.bufferedSnapshots) {
            if (
                buffered.seq !== plan.orderingRuntime.seq &&
                buffered.plan.supersedence.key === plan.supersedence.key &&
                isNewerMessage(read.msg, buffered.msg)
            ) {
                mutations.push({ kind: 'delete-buffered', trackKey: buffered.trackKey, seq: buffered.seq });
            }
        }
    }
    // Retain the existing ordered-message record until application delivery completes,
    // not merely until admission advances the contiguous sequence.
    mutations.push({
        kind: 'set-buffered',
        snapshot: {
            trackKey: plan.orderingRuntime.trackKey,
            seq: plan.orderingRuntime.seq,
            msg: read.msg,
            plan,
            carrier: toALDeliveryCarrier(read.source)
        },
        expireAtTimestamp: resolveExpireAtTimestampWithFallback(
            resolveALMessageExpireAtMs(read.msg, plan.effective),
            read.retention.bufferedMessageTtlMs,
            read.nowMs
        )
    });
    return mutations;
}

export function toALInboundSupersedenceMutations(
    acceptance: ALInboundMessageReadDto['supersedenceAcceptance'],
    supersedenceKey: string | undefined
): readonly ALInboundAdmissionMutation[] {
    if (!acceptance?.latestWrite || !supersedenceKey) {
        return [];
    }
    return [
        { kind: 'set-supersedence-latest', supersedenceKey, value: acceptance.latestWrite },
        ...acceptance.replacementWrites.map((replacement): ALInboundAdmissionMutation => ({
            kind: 'set-supersedence-replacement',
            msgId: replacement.msgId,
            value: replacement.value
        }))
    ];
}

function isNewerMessage(
    candidate: ALMessage,
    existing: ALMessage
): boolean {
    const candidateSeq = candidate.ordering?.seq;
    const existingSeq = existing.ordering?.seq;

    if (candidateSeq !== undefined || existingSeq !== undefined) {
        const seqComparison = (candidateSeq ?? Number.NEGATIVE_INFINITY) -
            (existingSeq ?? Number.NEGATIVE_INFINITY);
        if (seqComparison !== 0) {
            return seqComparison > 0;
        }
    }

    return (candidate.audit?.createdTs ?? candidate.id.ts) > (existing.audit?.createdTs ?? existing.id.ts);
}
