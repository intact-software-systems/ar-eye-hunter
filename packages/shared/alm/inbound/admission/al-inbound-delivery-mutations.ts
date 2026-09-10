import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import { resolveALMessageExpireAtMs } from '../../../al-contracts/al-policy.ts';
import { resolveExpireAtTimestampWithFallback } from '../../ALStoreRetention.ts';
import type { ALInboundAdmissionMutation, ALInboundMessageReadDto } from '../al-inbound-admission-store.ts';

/** The provenance, ordering and dedup rows an admitted message owns. */
export function toALInboundAdmittedMessageMutations(
    read: ALInboundMessageReadDto
): readonly ALInboundAdmissionMutation[] {
    const mutations: ALInboundAdmissionMutation[] = [
        {
            kind: 'set-msg-owner',
            value: {
                msgId: read.msg.id.msgId,
                senderId: read.msg.id.senderId,
                source: read.source,
                supersedenceKey: read.plan.supersedence.key ?? null
            },
            expireAtTimestamp: read.nowMs + read.retention.msgOwnerTtlMs
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
        expireAtTimestamp: read.nowMs + Math.max(0, read.plan.effective.dedup.opts.windowMs)
    });
    return mutations;
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
        snapshot: { trackKey: plan.orderingRuntime.trackKey, seq: plan.orderingRuntime.seq, msg: read.msg, plan },
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
