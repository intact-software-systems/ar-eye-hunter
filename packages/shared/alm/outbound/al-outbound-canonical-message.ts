import { Temporal } from '@js-temporal/polyfill';

import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '../../al-contracts/al-message-persistence-validation.ts';
import { resolveALMessageExpireAtMs } from '../../al-contracts/al-policy.ts';
import { fnv1a64 } from '../../queuebox/AppQueueIdentity.ts';
import {
    EntityStatus,
    isKeysEqual,
    type Key,
    type ResourceEntry
} from '../../queuebox/ResourceEntry.ts';
import { jsonEquals } from '../../repository/state-utils.ts';
import { toError } from '../../resilience/to-error.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import {
    decodeALAdmissionNumber,
    decodeALAdmissionRecord,
    decodeALAdmissionString
} from '../al-admission-value-validation.ts';
import { decodeALAdmissionResourceEntryKey } from '../decode-al-admission-resource-entry-key.ts';

export interface ALOutboundMessageReference {
    readonly key: Key;
    readonly typeId: string;
    readonly scope: string;
    readonly msgId: string;
    readonly senderId: string;
    readonly identity: string;
    readonly expiresAtMs: number;
}

export interface ALOutboundIdentityFact {
    readonly reference: ALOutboundMessageReference;
    readonly creationExpiry: string;
}

export function captureALOutboundCreationExpiry(message: ALMessage): string {
    return JSON.stringify({
        constraintsExpiresAtMs: message.constraints?.expiresAtMs ?? null,
        qosExpiry: message.qos?.expiry ?? null
    });
}

export function decodeALOutboundIdentityFact(value: unknown): ALOutboundIdentityFact {
    const fact = decodeALAdmissionRecord(value, ['reference', 'creationExpiry']);
    const creationExpiry = decodeALAdmissionString(fact.creationExpiry);
    const creation = decodeALAdmissionRecord(JSON.parse(creationExpiry), ['constraintsExpiresAtMs', 'qosExpiry']);
    if (creation.constraintsExpiresAtMs !== null) {
        const deadline = decodeALAdmissionNumber(creation.constraintsExpiresAtMs);
        if (!Number.isSafeInteger(deadline) || deadline < 0) {
            throw new TypeError('Canonical creation deadline is invalid');
        }
    }
    return { reference: decodeALOutboundMessageReference(fact.reference), creationExpiry };
}

export function decodeALOutboundIdentityEntry(entry: ResourceEntry): ALOutboundIdentityFact {
    try {
        return decodeALOutboundIdentityFact(JSON.parse(entry.resource));
    }
    catch (cause) {
        throw new ALAdmissionCorruptionError(JSON.stringify(entry.key), toError(cause));
    }
}

/**
 * Compact physical locators are not authority: the immutable identity fact detects collisions.
 * The scope hash leads (`resourceId`) so a browser session's rows are one bounded key-range delete.
 */
export function toALOutboundCanonicalKey(scope: string, message: ALMessage): Key {
    return {
        topicId: 'AL_OUTBOUND_MESSAGE',
        resourceId: `scope-${fnv1a64(scope)}`,
        contextId: `message-${fnv1a64(outboundMessageIdentity(message))}`
    };
}

/** Mirrors the canonical key's owner-ordered locator so both topics share one range per scope. */
export function toALOutboundIdentityKey(key: Key): Key {
    return {
        topicId: 'AL_OUTBOUND_IDENTITY',
        resourceId: key.resourceId,
        contextId: key.contextId
    };
}

export function toALOutboundMessageReference(
    scope: string,
    entry: ResourceEntry,
    message: ALMessage
): ALOutboundMessageReference {
    const expiresAtMs = resolveALMessageExpireAtMs(message);
    if (expiresAtMs === undefined || !Number.isSafeInteger(expiresAtMs)) {
        throw new TypeError('Canonical outbound messages require an absolute delivery deadline');
    }
    return {
        key: entry.key,
        typeId: entry.typeId,
        scope,
        msgId: message.id.msgId,
        senderId: message.id.senderId,
        identity: outboundMessageIdentity(message),
        expiresAtMs
    };
}

export function toALOutboundIdentityEntry(
    reference: ALOutboundMessageReference,
    canonical: ResourceEntry,
    creationExpiry: string
): ResourceEntry {
    return {
        key: toALOutboundIdentityKey(reference.key),
        typeId: 'AL_OUTBOUND_IDENTITY',
        resource: JSON.stringify({ reference, creationExpiry } satisfies ALOutboundIdentityFact),
        audit: { ...canonical.audit, expiryTs: Temporal.Instant.fromEpochMilliseconds(reference.expiresAtMs) },
        status: EntityStatus.COMPLETED,
        dequeueAudit: { attempts: 0 }
    };
}

export function decodeALOutboundMessageReference(value: unknown): ALOutboundMessageReference {
    const reference = decodeALAdmissionRecord(value, [
        'key',
        'typeId',
        'scope',
        'msgId',
        'senderId',
        'identity',
        'expiresAtMs'
    ]);
    const expiresAtMs = decodeALAdmissionNumber(reference.expiresAtMs);
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs < 0) {
        throw new TypeError('Outbound reference deadline is invalid');
    }
    return {
        key: decodeALAdmissionResourceEntryKey(reference.key),
        typeId: decodeALAdmissionString(reference.typeId),
        scope: decodeALAdmissionString(reference.scope),
        msgId: decodeALAdmissionString(reference.msgId),
        senderId: decodeALAdmissionString(reference.senderId),
        identity: decodeALAdmissionString(reference.identity),
        expiresAtMs
    };
}

export function decodeALOutboundCanonicalMessage(
    reference: ALOutboundMessageReference,
    entry: ResourceEntry | undefined,
    identityEntry: ResourceEntry | undefined
): ALMessage {
    const key = JSON.stringify(reference.key);
    try {
        if (entry === undefined || identityEntry === undefined) {
            throw new TypeError('Live outbound canonical message or identity fact is missing');
        }
        const identity = decodeALOutboundIdentityFact(JSON.parse(identityEntry.resource)).reference;
        const message = decodePersistedALMessage(entry.resource);
        if (
            !isKeysEqual(identityEntry.key, toALOutboundIdentityKey(reference.key)) ||
            identityEntry.typeId !== 'AL_OUTBOUND_IDENTITY' || !jsonEquals(identity, reference) ||
            identityEntry.audit.expiryTs.epochMilliseconds < reference.expiresAtMs ||
            !isKeysEqual(entry.key, reference.key) || entry.typeId !== reference.typeId ||
            message.id.msgId !== reference.msgId || message.id.senderId !== reference.senderId ||
            outboundMessageIdentity(message) !== reference.identity ||
            resolveALMessageExpireAtMs(message) !== reference.expiresAtMs ||
            entry.audit.expiryTs.epochMilliseconds < reference.expiresAtMs
        ) {
            throw new TypeError('Outbound canonical identity differs from its reference');
        }
        return message;
    }
    catch (cause) {
        throw new ALAdmissionCorruptionError(key, toError(cause));
    }
}

function outboundMessageIdentity(message: ALMessage): string {
    const id = message.id;
    return JSON.stringify([id.v, id.senderId, id.msgId, id.ts, id.sessionId ?? null, id.traceId ?? null]);
}
