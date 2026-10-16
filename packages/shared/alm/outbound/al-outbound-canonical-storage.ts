import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { toALFreezeComparableMessage } from '../../al-contracts/al-frozen-multicast-audience.ts';
import { decodePersistedALMessageRow } from '../../al-contracts/al-message-persistence-validation.ts';
import type { QueueBoxResourceEntryRepository } from '../../queuebox/queue-box-types.ts';
import { isKeysEqual, type ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { jsonEquals } from '../../repository/state-utils.ts';
import { Either } from '../../resilience/Either.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import type { ALStoredOutboundMessage } from './admission/al-outbound-admission-validation.ts';
import {
    captureALOutboundCreationExpiry,
    decodeALOutboundCanonicalMessage,
    decodeALOutboundIdentityFact,
    toALOutboundCanonicalKey,
    toALOutboundIdentityEntry,
    toALOutboundIdentityKey,
    toALOutboundMessageReference,
    toALSequenceMintComparableMessage
} from './al-outbound-canonical-message.ts';

export interface ALOutboundCanonicalReadInput {
    readonly nowMs: () => number;
    readonly queue: Pick<QueueBoxResourceEntryRepository, 'getItem'>;
    readonly scope: string;
    readonly message: ALMessage;
    readonly stored: ALStoredOutboundMessage | undefined;
    readonly observedEntry: ResourceEntry | undefined;
}

export interface ALOutboundCanonicalObservation {
    readonly entry: ResourceEntry | undefined;
    readonly message: ALMessage | undefined;
    readonly creationExpiry?: string;
}

export async function readALOutboundCanonicalMessage(
    input: ALOutboundCanonicalReadInput
): Promise<ALOutboundCanonicalObservation> {
    const key = input.stored?.reference.key ?? input.observedEntry?.key ??
        toALOutboundCanonicalKey(input.scope, input.message);
    const entry = input.observedEntry && isKeysEqual(input.observedEntry.key, key)
        ? input.observedEntry
        : await input.queue.getItem(key);
    const reference = input.stored?.reference ?? (entry
        ? toALOutboundMessageReference(input.scope, entry, decodePersistedALMessageRow(entry))
        : undefined);
    const identity = await input.queue.getItem(toALOutboundIdentityKey(key));
    if (reference !== undefined && reference.expiresAtMs <= input.nowMs()) {
        return { entry, message: undefined };
    }
    if ((identity || input.stored) && !entry) {
        throw new ALAdmissionCorruptionError(JSON.stringify(key), new TypeError('Live canonical payload is missing'));
    }
    if (!reference || !entry) {
        return { entry, message: undefined };
    }
    const unadmittedProducer = input.observedEntry !== undefined && input.stored === undefined &&
        input.observedEntry.key.topicId !== 'AL_OUTBOUND_MESSAGE' && identity === undefined;
    const message = decodeALOutboundCanonicalMessage(
        reference,
        entry,
        unadmittedProducer
            ? toALOutboundIdentityEntry(reference, entry, captureALOutboundCreationExpiry(input.message))
            : identity
    );
    const creationExpiry = identity
        ? decodeALOutboundIdentityFact(JSON.parse(identity.resource)).creationExpiry
        : captureALOutboundCreationExpiry(input.message);
    if (input.stored && input.stored.creationExpiry !== creationExpiry) {
        throw new ALAdmissionCorruptionError(
            JSON.stringify(key),
            new TypeError('Canonical creation observation differs from stored admission')
        );
    }
    const validated = validateCanonicalReuse(input.message, message, creationExpiry);
    if (validated.left) {
        throw new ALAdmissionCorruptionError(JSON.stringify(key), validated.left);
    }
    return { entry, message, creationExpiry };
}

function validateCanonicalReuse(
    original: ALMessage,
    canonical: ALMessage,
    creationExpiry: string | undefined
): Either<TypeError, ALMessage> {
    const sameCreation = creationExpiry === captureALOutboundCreationExpiry(original);
    const observed = sameCreation
        ? {
            ...original,
            qos: canonical.qos === undefined ? undefined : { ...original.qos, expiry: canonical.qos.expiry },
            constraints: { ...original.constraints, expiresAtMs: canonical.constraints?.expiresAtMs }
        }
        : original;
    return jsonEquals(
            observed,
            toALFreezeComparableMessage(observed, toALSequenceMintComparableMessage(observed, canonical))
        )
        ? Either.ofRight(canonical)
        : Either.ofLeft(new TypeError('Canonical identity has conflicting content'));
}
