import type { ALMessageRejection } from '../../al-contracts/al-message-persistence-validation.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '../../al-contracts/al-message-resource-limits.ts';
import { Either } from '../../resilience/Either.ts';
import type {
    ALInboundAdmissionMutation,
    ALInboundAdmissionObservations,
    ALInboundCommitBundle,
    ALInboundControlOwnerIndex
} from './al-inbound-admission-store.ts';
import { decodeALInboundSource } from './al-inbound-source-validation.ts';

export function validateALInboundCommitBundle(
    bundle: ALInboundCommitBundle
): Either<ALMessageRejection, ALInboundCommitBundle> {
    if (!bundle.observations || bundle.observations.senderId !== bundle.senderId || !bundle.observations.msgId) {
        return invalidBundle('Inbound admission candidate has invalid original observations');
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
        const mutationError = validateMutation(mutation, bundle);
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
    if (mutation.kind === 'set-msg-owner') {
        try {
            decodeALInboundSource(mutation.source);
        }
        catch {
            return 'Inbound admission candidate has invalid message provenance';
        }
    }
    if (
        mutation.kind === 'set-control-owners' &&
        (!isValidControlOwnerIndex(bundle.observations.controlOwners) || !isValidControlOwnerIndex(mutation.value))
    ) {
        return 'Inbound admission candidate has an invalid control owner index';
    }
    return undefined;
}

function matchesOriginalObservation(
    mutation: ALInboundAdmissionMutation,
    observed: ALInboundAdmissionObservations
): boolean {
    switch (mutation.kind) {
        case 'set-msg-owner':
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
