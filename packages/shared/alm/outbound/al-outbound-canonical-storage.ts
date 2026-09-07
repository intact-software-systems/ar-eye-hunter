import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '../../al-contracts/al-message-persistence-validation.ts';
import type { QueueBoxResourceEntryRepository } from '../../queuebox/queue-box-types.ts';
import { hasSameResourceEntryValue } from '../../queuebox/resource-entry-observations.ts';
import { EntityStatus, type ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { jsonEquals } from '../../repository/state-utils.ts';
import { Either } from '../../resilience/Either.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import type { ALAdmissionWorkWriteContext } from '../al-admission-work-backend.ts';
import { ALAdmissionBackendConflictError } from '../ALAdmissionBackendConflictError.ts';
import type { ALStoredOutboundMessage } from './al-outbound-admission-validation.ts';
import {
    captureALOutboundCreationExpiry,
    decodeALOutboundCanonicalMessage,
    decodeALOutboundIdentityFact,
    toALOutboundCanonicalKey,
    toALOutboundIdentityEntry,
    toALOutboundIdentityKey,
    toALOutboundMessageReference
} from './al-outbound-canonical-message.ts';

export interface ALOutboundCanonicalReadInput {
    readonly nowMs: () => number;
    readonly queue: QueueBoxResourceEntryRepository;
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

export interface ALOutboundCanonicalFactWrite {
    readonly entry: ResourceEntry;
    readonly expected: ResourceEntry | undefined;
    readonly replaceExisting: boolean;
}

export async function readALOutboundCanonicalMessage(
    input: ALOutboundCanonicalReadInput
): Promise<ALOutboundCanonicalObservation> {
    const key = input.observedEntry?.key ?? input.stored?.reference.key ??
        toALOutboundCanonicalKey(input.scope, input.message);
    const entry = input.observedEntry ?? await input.queue.getItem(key);
    const reference = input.stored?.reference ?? (entry
        ? toALOutboundMessageReference(input.scope, entry, decodePersistedALMessage(entry.resource))
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
    return jsonEquals(observed, canonical)
        ? Either.ofRight(canonical)
        : Either.ofLeft(new TypeError('Canonical identity has conflicting content'));
}

export interface ALOutboundCanonicalWriteReadInput {
    readonly queue: QueueBoxResourceEntryRepository;
    readonly scope: string;
    readonly entry: ResourceEntry | undefined;
    readonly creationExpiry: string;
    readonly activatePendingCanonical: boolean;
    readonly nowMs: () => number;
}

export async function readALOutboundCanonicalWrites(
    input: ALOutboundCanonicalWriteReadInput
): Promise<readonly ALOutboundCanonicalFactWrite[]> {
    const { queue, scope, entry, creationExpiry, activatePendingCanonical } = input;
    if (!entry) {
        return [];
    }
    const expected = await queue.getItem(entry.key);
    const reference = toALOutboundMessageReference(scope, entry, decodePersistedALMessage(entry.resource));
    const identity = toALOutboundIdentityEntry(reference, entry, creationExpiry);
    const expectedIdentity = await queue.getItem(identity.key);
    // R = D: an awaited getter may already have evicted the other fact at expiry.
    if (reference.expiresAtMs > input.nowMs()) {
        if (expectedIdentity) {
            decodeALOutboundCanonicalMessage(reference, entry, expectedIdentity);
            if (decodeALOutboundIdentityFact(JSON.parse(expectedIdentity.resource)).creationExpiry !== creationExpiry) {
                throw new ALAdmissionCorruptionError(
                    JSON.stringify(identity.key),
                    new TypeError('Canonical creation observation differs')
                );
            }
        }
        if (expected?.key.topicId === 'AL_OUTBOUND_MESSAGE' && !expectedIdentity) {
            throw new ALAdmissionCorruptionError(
                JSON.stringify(expected.key),
                new TypeError('Live canonical identity fact is missing')
            );
        }
        if (expected && expected.resource !== entry.resource) {
            throw new ALAdmissionCorruptionError(
                JSON.stringify(expected.key),
                new TypeError('Canonical identity has conflicting content')
            );
        }
    }
    return [{
        entry,
        expected,
        replaceExisting: activatePendingCanonical && expected?.status === EntityStatus.COMPLETED &&
            entry.status === EntityStatus.NEW
    }, { entry: identity, expected: expectedIdentity, replaceExisting: false }];
}

/** Uses the caller's admission transaction; both observations precede either buffered write. */
export async function writeALOutboundCanonicalFacts(
    tx: ALAdmissionWorkWriteContext,
    writes: readonly ALOutboundCanonicalFactWrite[],
    nowMs: () => number
): Promise<'written' | 'expired'> {
    const observed: (ResourceEntry | undefined)[] = [];
    for (const write of writes) {
        observed.push(await tx.readWork(write.entry.key));
    }
    if (writes.some((write) => write.entry.audit.expiryTs.epochMilliseconds <= nowMs())) {
        return 'expired';
    }
    for (const [index, write] of writes.entries()) {
        const current = observed[index];
        if (
            current === undefined || write.expected === undefined
                ? current !== write.expected
                : !hasSameResourceEntryValue(current, write.expected)
        ) {
            throw new ALAdmissionBackendConflictError('Outbound canonical fact observation changed');
        }
    }
    for (const [index, write] of writes.entries()) {
        if (!observed[index] || write.replaceExisting) {
            tx.writeWork(write.entry);
        }
    }
    return 'written';
}
