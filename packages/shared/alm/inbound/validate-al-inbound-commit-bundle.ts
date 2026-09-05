import type { ALMessageRejection } from '../../al-contracts/al-message-persistence-validation.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '../../al-contracts/al-message-resource-limits.ts';
import { Either } from '../../resilience/Either.ts';
import type {
    ALInboundCommitBundle,
    ALInboundControlOwnerIndex
} from './al-inbound-admission-store.ts';
import { decodeALInboundSource } from './al-inbound-source-validation.ts';

export function validateALInboundCommitBundle(
    bundle: ALInboundCommitBundle
): Either<ALMessageRejection, ALInboundCommitBundle> {
    if (!Number.isSafeInteger(bundle.versionExpireAtTimestamp)) {
        return invalidBundle('Inbound admission candidate has an invalid version expiry');
    }
    if (
        bundle.mutations.length > AL_MESSAGE_RESOURCE_LIMITS.collectionEntries ||
        bundle.durableEffects.length > AL_MESSAGE_RESOURCE_LIMITS.collectionEntries
    ) {
        return invalidBundle('Inbound admission candidate exceeds the collection limit');
    }
    const effectError = validateDurableEffects(bundle);
    if (effectError) {
        return invalidBundle(effectError);
    }
    let ownerExpireAtTimestamp: number | undefined;
    let ownedWorkExpireAtTimestamp = computeDurableEffectsExpiry(bundle);
    for (const mutation of bundle.mutations) {
        const mutationError = validateMutation(mutation, bundle.senderId);
        if (mutationError) {
            return invalidBundle(mutationError);
        }
        if (mutation.kind === 'set-msg-owner') {
            ownerExpireAtTimestamp = mutation.expireAtTimestamp;
        }
        if (
            mutation.kind === 'set-buffered' || mutation.kind === 'set-control-pending' ||
            mutation.kind === 'set-control-owners'
        ) {
            ownedWorkExpireAtTimestamp = Math.max(ownedWorkExpireAtTimestamp, mutation.expireAtTimestamp);
        }
    }
    if (ownerExpireAtTimestamp !== undefined && ownerExpireAtTimestamp < ownedWorkExpireAtTimestamp) {
        return invalidBundle('Inbound admission candidate provenance expires before its owned work');
    }
    return Either.ofRight(bundle);
}

function validateDurableEffects(bundle: ALInboundCommitBundle): string | undefined {
    const effectIds = new Set<string>();
    for (const effect of bundle.durableEffects) {
        if (effectIds.has(effect.effectId) || !Number.isSafeInteger(effect.expireAtTimestamp)) {
            return 'Inbound admission candidate has invalid durable effect ownership';
        }
        effectIds.add(effect.effectId);
    }
    return undefined;
}

function validateMutation(mutation: ALInboundCommitBundle['mutations'][number], senderId: string): string | undefined {
    if ('expireAtTimestamp' in mutation && !Number.isSafeInteger(mutation.expireAtTimestamp)) {
        return 'Inbound admission candidate has an invalid persistence expiry';
    }
    if (mutation.kind === 'set-msg-owner') {
        if (mutation.senderId !== senderId) {
            return 'Inbound admission candidate message owner does not match its sender fence';
        }
        try {
            decodeALInboundSource(mutation.source);
        }
        catch {
            return 'Inbound admission candidate has invalid message provenance';
        }
    }
    if (
        mutation.kind === 'set-control-owners' &&
        (!mutation.msgId || !isValidControlOwnerIndex(mutation.expected) || !isValidControlOwnerIndex(mutation.value))
    ) {
        return 'Inbound admission candidate has an invalid control owner index';
    }
    return undefined;
}

function computeDurableEffectsExpiry(bundle: ALInboundCommitBundle): number {
    let expireAtTimestamp = 0;
    for (const effect of bundle.durableEffects) {
        expireAtTimestamp = Math.max(expireAtTimestamp, effect.expireAtTimestamp);
        if (effect.payload.kind === 'dispatch-local' || effect.payload.kind === 'enqueue-inbox') {
            expireAtTimestamp = Math.max(
                expireAtTimestamp,
                effect.payload.entry.audit.expiryTs.epochMilliseconds
            );
        }
    }
    return expireAtTimestamp;
}

function isValidControlOwnerIndex(value: ALInboundControlOwnerIndex | undefined): boolean {
    if (value === undefined) {
        return true;
    }
    if (
        value.values.length > AL_MESSAGE_RESOURCE_LIMITS.collectionEntries ||
        (value.ambiguous && value.values.length !== 0)
    ) {
        return false;
    }
    const peerIds = new Set<string>();
    for (const entry of value.values) {
        if (
            entry.peerId.length === 0 || entry.senderId === '' || peerIds.has(entry.peerId)
        ) {
            return false;
        }
        peerIds.add(entry.peerId);
    }
    return true;
}

function invalidBundle(message: string): Either<ALMessageRejection, ALInboundCommitBundle> {
    return Either.ofLeft({ code: 'malformed', message });
}
