import { decodePersistedALMessageRow } from '../../../al-contracts/al-message-persistence-validation.ts';
import type { QueueBoxResourceEntryRepository } from '../../../queuebox/queue-box-types.ts';
import { hasSameResourceEntryValue } from '../../../queuebox/resource-entry-observations.ts';
import { EntityStatus, isKeysEqual, type ResourceEntry } from '../../../queuebox/ResourceEntry.ts';
import { ALAdmissionCorruptionError } from '../../al-admission-decoder.ts';
import type { ALAdmissionWorkWriteContext } from '../../al-admission-work-backend.ts';
import { ALAdmissionBackendConflictError } from '../../ALAdmissionBackendConflictError.ts';
import {
    decodeALOutboundCanonicalMessage,
    decodeALOutboundIdentityFact,
    isALOutboundCanonicalReplacement,
    toALOutboundIdentityEntry,
    toALOutboundMessageReference
} from '../al-outbound-canonical-message.ts';

export interface ALOutboundCanonicalFactWrite {
    readonly entry: ResourceEntry;
    readonly expected: ResourceEntry | undefined;
    /** Set when `expected` is the row as this caller's claim returned it, so the write fences that claim. */
    readonly claimed: ResourceEntry | undefined;
    readonly replaceExisting: boolean;
}

export interface ALOutboundCanonicalWriteReadInput {
    readonly queue: Pick<QueueBoxResourceEntryRepository, 'getItem'>;
    readonly scope: string;
    readonly entry: ResourceEntry | undefined;
    /** The canonical row as the caller's own claim returned it; it answers for that row instead of a read. */
    readonly claimed: ResourceEntry | undefined;
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
    const claimed = input.claimed && isKeysEqual(input.claimed.key, entry.key) ? input.claimed : undefined;
    const reference = toALOutboundMessageReference(scope, entry, decodePersistedALMessageRow(entry));
    const identity = toALOutboundIdentityEntry(reference, entry, creationExpiry);
    const [expected, expectedIdentity] = await Promise.all([
        claimed ?? queue.getItem(entry.key),
        queue.getItem(identity.key)
    ]);
    const replacing = isALOutboundCanonicalReplacement(activatePendingCanonical, expected, entry);
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
        if (expected && expected.resource !== entry.resource && !replacing) {
            throw new ALAdmissionCorruptionError(
                JSON.stringify(expected.key),
                new TypeError('Canonical identity has conflicting content')
            );
        }
    }
    return [{
        entry,
        expected,
        claimed,
        replaceExisting: replacing ||
            (activatePendingCanonical && expected?.status === EntityStatus.COMPLETED &&
                entry.status === EntityStatus.NEW)
    }, { entry: identity, expected: expectedIdentity, claimed: undefined, replaceExisting: false }];
}

/** Every canonical fact write with the slot its row holds now, as one admission write re-read them. */
export interface ALOutboundCanonicalFactSlots {
    readonly writes: readonly ALOutboundCanonicalFactWrite[];
    readonly slots: readonly (ResourceEntry | undefined)[];
}

/** Re-reads every canonical fact slot inside the caller's admission write, all at once. */
export async function readALOutboundCanonicalFactSlots(
    tx: ALAdmissionWorkWriteContext,
    writes: readonly ALOutboundCanonicalFactWrite[]
): Promise<ALOutboundCanonicalFactSlots> {
    const slots = await Promise.all(
        writes.map((write) =>
            write.claimed === undefined ? tx.readWork(write.entry.key) : tx.readClaimedWork(write.claimed)
        )
    );
    return { writes, slots };
}

/** Uses the caller's admission transaction; every slot was re-read before either buffered write. */
export function writeALOutboundCanonicalFacts(
    tx: ALAdmissionWorkWriteContext,
    observed: ALOutboundCanonicalFactSlots,
    nowMs: () => number
): 'written' | 'expired' {
    const { writes, slots } = observed;
    if (writes.some((write) => write.entry.audit.expiryTs.epochMilliseconds <= nowMs())) {
        return 'expired';
    }
    if (writes.some((write, index) => hasMovedALOutboundCanonicalSlot(slots[index], write.expected))) {
        throw new ALAdmissionBackendConflictError('Outbound canonical fact observation changed');
    }
    for (const [index, write] of writes.entries()) {
        if (!slots[index] || write.replaceExisting) {
            tx.writeWork(write.entry);
        }
    }
    return 'written';
}

function hasMovedALOutboundCanonicalSlot(
    current: ResourceEntry | undefined,
    expected: ResourceEntry | undefined
): boolean {
    return current === undefined || expected === undefined
        ? current !== expected
        : !hasSameResourceEntryValue(current, expected);
}
