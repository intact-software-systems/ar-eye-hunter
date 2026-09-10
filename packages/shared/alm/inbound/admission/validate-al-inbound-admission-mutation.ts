import type {
    ALInboundAdmissionMutation,
    ALInboundAdmissionObservations,
    ALInboundCommitBundle
} from '../al-inbound-admission-store.ts';
import { decodeALInboundDeliveryProgress } from '../al-inbound-ordering-validation.ts';
import { decodeALInboundControlOwnerIndex, decodeALInboundSource } from '../al-inbound-source-validation.ts';

/** Every reason one mutation may not be committed, in the order the bundle rejects them. */
export function validateALInboundAdmissionMutation(
    mutation: ALInboundAdmissionMutation,
    bundle: ALInboundCommitBundle
): readonly string[] {
    const issues: string[] = [];
    if (!matchesOriginalObservation(mutation, bundle.observations)) {
        issues.push('Inbound admission candidate writes outside its original observations');
    }
    if ('expireAtTimestamp' in mutation && !Number.isSafeInteger(mutation.expireAtTimestamp)) {
        issues.push('Inbound admission candidate has an invalid persistence expiry');
    }
    if (mutation.kind === 'set-delivery-progress') {
        try {
            decodeALInboundDeliveryProgress(mutation.value);
        }
        catch {
            issues.push('Inbound admission candidate has invalid delivery progress');
        }
    }
    if (mutation.kind === 'set-msg-owner') {
        try {
            decodeALInboundSource(mutation.value.source);
        }
        catch {
            issues.push('Inbound admission candidate has invalid message provenance');
        }
    }
    // Readers clamp a buffered slot against the retention the row itself states, so the two must agree.
    if (mutation.kind === 'set-inbound-message' && mutation.value.retainUntilMs !== mutation.expireAtTimestamp) {
        issues.push('Inbound admission candidate retains its canonical message for an undeclared lifetime');
    }
    if (mutation.kind === 'set-control-owners') {
        try {
            if (bundle.observations.controlOwners !== undefined) {
                decodeALInboundControlOwnerIndex(bundle.observations.controlOwners);
            }
            decodeALInboundControlOwnerIndex(mutation.value);
        }
        catch {
            issues.push('Inbound admission candidate has an invalid control owner index');
        }
    }
    return issues;
}

function matchesOriginalObservation(
    mutation: ALInboundAdmissionMutation,
    observed: ALInboundAdmissionObservations
): boolean {
    switch (mutation.kind) {
        case 'set-msg-owner':
        case 'set-inbound-message':
            return mutation.value.msgId === observed.msgId && mutation.value.senderId === observed.senderId;
        case 'set-control-acks':
        case 'set-control-pending':
        case 'delete-control-pending':
            return mutation.msgId === observed.msgId && mutation.senderId === observed.senderId;
        case 'set-control-owners':
            return mutation.msgId === observed.msgId;
        case 'set-dedup':
            return mutation.dedupKey === observed.dedup?.key;
        case 'set-ordering':
            return mutation.trackKey === observed.ordering?.trackKey;
        case 'set-supersedence-latest':
            return mutation.supersedenceKey === observed.supersedence.key;
        case 'set-supersedence-replacement':
            return mutation.value.byMsgId === observed.msgId && observed.supersedence.key !== undefined;
        case 'set-delivery-progress':
            return mutation.trackKey === observed.deliveryProgress?.trackKey &&
                mutation.value.expireAtTimestamp >= (observed.deliveryProgress.value?.expireAtTimestamp ?? 0) &&
                (
                    (mutation.value.completedThrough === (observed.deliveryProgress.value?.completedThrough ?? 0) &&
                        mutation.trackKey === observed.ordering?.trackKey) ||
                    (mutation.value.completedThrough === (observed.deliveryProgress.value?.completedThrough ?? 0) + 1 &&
                        mutation.value.completedThrough === observed.buffered?.seq)
                );
        case 'set-buffered':
        case 'delete-buffered': {
            const position = mutation.kind === 'set-buffered' ? mutation.snapshot : mutation;
            return observed.ordering?.trackKey === position.trackKey ||
                (observed.buffered?.trackKey === position.trackKey && observed.buffered.seq === position.seq);
        }
    }
}
