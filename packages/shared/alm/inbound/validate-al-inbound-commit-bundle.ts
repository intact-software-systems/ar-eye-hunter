import { decodeALMessageValue, type ALMessageRejection } from '../../al-contracts/al-message-persistence-validation.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '../../al-contracts/al-message-resource-limits.ts';
import { Either } from '../../resilience/Either.ts';
import type {
    ALInboundAdmissionMutation,
    ALInboundAdmissionObservations,
    ALInboundCommitBundle
} from './al-inbound-admission-store.ts';
import {
    decodeALInboundDeliveryProgress,
    validateALInboundBufferedMessages
} from './al-inbound-ordering-validation.ts';
import { decodeALInboundControlOwnerIndex, decodeALInboundSource } from './al-inbound-source-validation.ts';
import { validateALInboundWorkWrites } from './al-inbound-work-entry.ts';

export function validateALInboundCommitBundle(
    bundle: ALInboundCommitBundle,
    namespace: string
): Either<ALMessageRejection, ALInboundCommitBundle> {
    if (
        bundle.admissionExpiresAtMs !== null &&
        (!Number.isSafeInteger(bundle.admissionExpiresAtMs) || bundle.admissionExpiresAtMs < 0)
    ) {
        return invalidBundle('Inbound admission candidate has invalid delivery eligibility');
    }
    if (!bundle.observations || bundle.observations.senderId !== bundle.senderId || !bundle.observations.msgId) {
        return invalidBundle('Inbound admission candidate has invalid original observations');
    }
    if (
        bundle.mutations.length >
            AL_MESSAGE_RESOURCE_LIMITS.collectionEntries + AL_MESSAGE_RESOURCE_LIMITS.bufferedMessages ||
        bundle.durableEffects.length > AL_MESSAGE_RESOURCE_LIMITS.collectionEntries
    ) {
        return invalidBundle('Inbound admission candidate exceeds the collection limit');
    }
    const effects = validateALInboundWorkWrites(bundle.durableEffects, namespace);
    if (effects.left) {
        return Either.ofLeft(effects.left);
    }
    const provenanceExpireAtTimestamps: number[] = [];
    let ownedWorkExpireAtTimestamp = computeDurableEffectsExpiry(bundle);
    for (const mutation of bundle.mutations) {
        const mutationError = validateMutation(mutation, bundle);
        if (mutationError) {
            return invalidBundle(mutationError);
        }
        if (mutation.kind === 'set-msg-owner' || mutation.kind === 'set-inbound-message') {
            provenanceExpireAtTimestamps.push(mutation.expireAtTimestamp);
        }
        if (
            mutation.kind === 'set-buffered' || mutation.kind === 'set-control-acks' ||
            mutation.kind === 'set-control-pending' || mutation.kind === 'set-control-owners'
        ) {
            ownedWorkExpireAtTimestamp = Math.max(ownedWorkExpireAtTimestamp, mutation.expireAtTimestamp);
        }
    }
    if (provenanceExpireAtTimestamps.some((expiry) => expiry < ownedWorkExpireAtTimestamp)) {
        return invalidBundle('Inbound admission candidate provenance expires before its owned work');
    }
    const messageIssues = [...validateCanonicalMessages(bundle), ...validateALInboundBufferedMessages(bundle)];
    if (messageIssues.length > 0) {
        return Either.ofLeft(messageIssues[0]);
    }
    return Either.ofRight(bundle);
}

function validateCanonicalMessages(bundle: ALInboundCommitBundle): readonly ALMessageRejection[] {
    const issues: ALMessageRejection[] = [];
    for (const mutation of bundle.mutations) {
        if (mutation.kind !== 'set-inbound-message') {
            continue;
        }
        const decoded = decodeALMessageValue(mutation.value.msg);
        if (decoded.left) {
            issues.push(decoded.left);
        }
        else if (
            mutation.value.msg.id.msgId !== mutation.value.msgId ||
            mutation.value.msg.id.senderId !== mutation.value.senderId
        ) {
            issues.push({
                code: 'malformed',
                message: 'Inbound admission candidate has an invalid canonical message'
            });
        }
    }
    return issues;
}

function validateMutation(
    mutation: ALInboundCommitBundle['mutations'][number],
    bundle: ALInboundCommitBundle
): string | undefined {
    if (!matchesOriginalObservation(mutation, bundle.observations)) {
        return 'Inbound admission candidate writes outside its original observations';
    }
    if ('expireAtTimestamp' in mutation && !Number.isSafeInteger(mutation.expireAtTimestamp)) {
        return 'Inbound admission candidate has an invalid persistence expiry';
    }
    if (mutation.kind === 'set-delivery-progress') {
        try {
            decodeALInboundDeliveryProgress(mutation.value);
        }
        catch {
            return 'Inbound admission candidate has invalid delivery progress';
        }
    }
    if (mutation.kind === 'set-msg-owner') {
        try {
            decodeALInboundSource(mutation.value.source);
        }
        catch {
            return 'Inbound admission candidate has invalid message provenance';
        }
    }
    // Readers clamp a buffered slot against the retention the row itself states, so the two must agree.
    if (mutation.kind === 'set-inbound-message' && mutation.value.retainUntilMs !== mutation.expireAtTimestamp) {
        return 'Inbound admission candidate retains its canonical message for an undeclared lifetime';
    }
    if (mutation.kind === 'set-control-owners') {
        try {
            if (bundle.observations.controlOwners !== undefined) {
                decodeALInboundControlOwnerIndex(bundle.observations.controlOwners);
            }
            decodeALInboundControlOwnerIndex(mutation.value);
        }
        catch {
            return 'Inbound admission candidate has an invalid control owner index';
        }
    }
    return undefined;
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

function computeDurableEffectsExpiry(bundle: ALInboundCommitBundle): number {
    let expireAtTimestamp = 0;
    for (const effect of bundle.durableEffects) {
        expireAtTimestamp = Math.max(expireAtTimestamp, effect.expireAtTimestamp);
    }
    return expireAtTimestamp;
}

function invalidBundle(message: string): Either<ALMessageRejection, ALInboundCommitBundle> {
    return Either.ofLeft({ code: 'malformed', message });
}
