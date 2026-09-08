import { decodePersistedALMessage } from '../../al-contracts/al-message-persistence-validation.ts';
import { PersistenceWriteExpiredError } from '../../persistence/persistence-write-deadline.ts';
import { EntityStatus, type ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { jsonEquals } from '../../repository/state-utils.ts';
import { Either } from '../../resilience/Either.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import type { ALAdmissionWorkBackend } from '../al-admission-work-backend.ts';
import { ALAdmissionBackendConflictError } from '../ALAdmissionBackendConflictError.ts';
import type { ALOutboundPreparedMessageDecoder } from './al-outbound-admission-store.ts';
import type { ALOutboundCapturedPolicy } from './al-outbound-admission-validation.ts';
import type { ALOutboundMessageReference } from './al-outbound-canonical-message.ts';
import {
    readALOutboundCanonicalWrites,
    writeALOutboundCanonicalFacts,
    type ALOutboundCanonicalFactWrite
} from './al-outbound-canonical-storage.ts';
import {
    computeALOutboundWorkEntry,
    decodeALOutboundWorkEntry,
    isPendingALOutboundWork
} from './al-outbound-work-entry.ts';
import { toALOutboundEffectId } from './to-al-outbound-effect-id.ts';

export interface ALOutboundPendingAdmission<TPrepared> {
    readonly kind: 'admit-message';
    readonly message: ALOutboundMessageReference;
    readonly policy: ALOutboundCapturedPolicy;
    readonly preparedMessages: readonly TPrepared[];
}

export interface RetainALOutboundPendingAdmissionInput<TPrepared> {
    readonly canonicalEntry: ResourceEntry;
    readonly creationExpiry: string;
    readonly payload: ALOutboundPendingAdmission<TPrepared>;
    readonly decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>;
}

export function toALOutboundPendingAdmissionId(message: ALOutboundMessageReference): string {
    return toALOutboundEffectId(['admit-message', message.senderId, message.identity]);
}

export interface ALOutboundPendingAdmissionStorage {
    readonly backend: ALAdmissionWorkBackend;
    readonly namespace: string;
    readonly nowMs: () => number;
}

/** This queue-only write owns a failed first admission; it never writes admission metadata. */
export async function retainALOutboundPendingAdmission<TPrepared>(
    storage: ALOutboundPendingAdmissionStorage,
    input: RetainALOutboundPendingAdmissionInput<TPrepared>
): Promise<'pending' | 'conflict' | 'expired'> {
    const { backend, namespace, nowMs } = storage;
    const canonical = { ...input.canonicalEntry, status: EntityStatus.COMPLETED };
    const facts = await readALOutboundCanonicalWrites({
        queue: backend.workQueue,
        scope: input.payload.message.scope,
        entry: canonical,
        creationExpiry: input.creationExpiry,
        activatePendingCanonical: false,
        nowMs
    });
    const entry = computeALOutboundWorkEntry({
        namespace,
        effectId: toALOutboundPendingAdmissionId(input.payload.message),
        payload: input.payload,
        observedAtMs: nowMs(),
        retryAtMs: nowMs(),
        expireAtTimestamp: input.payload.message.expiresAtMs
    });
    const expected = await backend.workQueue.getItem(entry.key);
    if (input.payload.message.expiresAtMs <= nowMs()) {
        return 'expired';
    }
    const preparedRead = {
        decodePrepared: input.decodePrepared,
        message: decodePersistedALMessage(canonical.resource)
    };
    const payload = decodeALOutboundWorkEntry(entry, namespace, preparedRead).payload;
    const existing = expected ? decodeALOutboundWorkEntry(expected, namespace, preparedRead).payload : undefined;
    const validated = validatePendingObservation(payload, existing);
    if (validated.left) {
        throw new ALAdmissionCorruptionError(JSON.stringify(entry.key), validated.left);
    }
    if (expected && !isPendingALOutboundWork(expected)) {
        return 'conflict';
    }
    const writes = [...facts, { entry, expected, replaceExisting: false }];
    try {
        const result = await backend.write(
            (tx) => writeALOutboundCanonicalFacts(tx, writes, nowMs),
            input.payload.message.expiresAtMs
        );
        return result === 'expired' ? 'expired' : 'pending';
    }
    catch (error) {
        if (error instanceof PersistenceWriteExpiredError) {
            return 'expired';
        }
        if (!(error instanceof ALAdmissionBackendConflictError)) {
            throw error;
        }
        return await readRacedPendingOwner(storage, writes, input.payload.message.expiresAtMs);
    }
}

function validatePendingObservation<T>(candidate: T, existing: T | undefined): Either<TypeError, T> {
    return existing === undefined || jsonEquals(candidate, existing)
        ? Either.ofRight(candidate)
        : Either.ofLeft(new TypeError('Pending outbound identity has conflicting captured admission'));
}

async function readRacedPendingOwner(
    storage: ALOutboundPendingAdmissionStorage,
    writes: readonly ALOutboundCanonicalFactWrite[],
    expiresAtMs: number
): Promise<'pending' | 'conflict' | 'expired'> {
    const { backend, nowMs } = storage;
    const current = await Promise.all(writes.map((write) => backend.workQueue.getItem(write.entry.key)));
    if (expiresAtMs <= nowMs()) {
        return 'expired';
    }
    const pending = current.at(-1);
    if (!pending || !isPendingALOutboundWork(pending)) {
        return 'conflict';
    }
    const owned = writes.every((write, index) => {
        const row = current[index];
        return row !== undefined && row.typeId === write.entry.typeId &&
            row.resource === write.entry.resource && row.audit.expiryTs.equals(write.entry.audit.expiryTs);
    });
    return owned ? 'pending' : 'conflict';
}
