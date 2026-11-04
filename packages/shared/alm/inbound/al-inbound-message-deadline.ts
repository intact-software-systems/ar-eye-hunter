import { Temporal } from '@js-temporal/polyfill';
import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { assertALPublicationProofSigningInputKept } from '../../al-contracts/publication-proof/al-publication-proof.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';

/** A message whose retained deadline is part of its type, so no reader has to assert one. */
export type ALDeadlinedMessage =
    & ALMessage
    & Readonly<{
        constraints: NonNullable<ALMessage['constraints']> & Readonly<{ expiresAtMs: number; }>;
    }>;

/** The retained deadline is part of a pending admission's identity, so a row without one is corrupt. */
export function decodeALDeadlinedMessage(msg: ALMessage): ALDeadlinedMessage {
    const expiresAtMs = msg.constraints?.expiresAtMs;
    if (typeof expiresAtMs !== 'number' || !Number.isSafeInteger(expiresAtMs)) {
        throw new TypeError('Retained inbound message carries no deadline');
    }
    return { ...msg, constraints: { ...msg.constraints, expiresAtMs } };
}

/**
 * A signed message keeps its origin's expiry, a signed field: the receiver's own earlier deadline is the one its
 * plan resolves and its work rows carry. Every other message takes the earlier of the two.
 *
 * Invariant: a proof here is a granted publication's. The RTC planner refuses a proof on any other topic at its first
 * plan (`unauthorized: proof-on-ungranted-topic`), so such a frame commits no work, and verifies a granted frame before
 * it forwards or delivers it; a WS message carries one only after a hand-over its server already normalized.
 */
export function toALInboundMessageWithDeadline(msg: ALMessage, expireAtTimestamp: number): ALDeadlinedMessage {
    const ownExpiresAtMs = msg.constraints?.expiresAtMs ?? expireAtTimestamp;
    const deadlined = {
        ...msg,
        constraints: {
            ...msg.constraints,
            expiresAtMs: msg.proof === undefined ? Math.min(ownExpiresAtMs, expireAtTimestamp) : ownExpiresAtMs
        }
    };
    if (msg.proof !== undefined) {
        assertALPublicationProofSigningInputKept(msg, deadlined);
    }
    return deadlined;
}

export function toALInboundDispatchEntry(
    entry: ResourceEntry,
    msg: ALMessage,
    expireAtTimestamp: number
): ResourceEntry {
    const expiresAtMs = Math.min(
        entry.audit.expiryTs.epochMilliseconds,
        msg.constraints?.expiresAtMs ?? expireAtTimestamp,
        expireAtTimestamp
    );
    return {
        ...entry,
        resource: JSON.stringify(msg),
        audit: { ...entry.audit, expiryTs: Temporal.Instant.fromEpochMilliseconds(expiresAtMs) }
    };
}
