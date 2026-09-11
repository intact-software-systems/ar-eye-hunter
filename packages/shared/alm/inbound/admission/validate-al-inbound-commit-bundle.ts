import {
    decodeALMessageValue,
    type ALMessageRejection
} from '../../../al-contracts/al-message-persistence-validation.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '../../../al-contracts/al-message-resource-limits.ts';
import { Either } from '../../../resilience/Either.ts';
import type { ALInboundCommitBundle } from '../al-inbound-admission-store.ts';
import { validateALInboundBufferedMessages } from '../al-inbound-ordering-validation.ts';
import { validateALInboundWorkWrites } from '../al-inbound-work-entry.ts';
import { validateALInboundAdmissionMutation } from './validate-al-inbound-admission-mutation.ts';

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
        const mutationIssues = validateALInboundAdmissionMutation(mutation, bundle);
        if (mutationIssues.length > 0) {
            return invalidBundle(mutationIssues[0]!);
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
