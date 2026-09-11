import { Temporal } from '@js-temporal/polyfill';
import type { ALMessage } from '../../al-contracts/al-contract.ts';
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

export function toALInboundMessageWithDeadline(msg: ALMessage, expireAtTimestamp: number): ALDeadlinedMessage {
    return {
        ...msg,
        constraints: {
            ...msg.constraints,
            expiresAtMs: Math.min(msg.constraints?.expiresAtMs ?? expireAtTimestamp, expireAtTimestamp)
        }
    };
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
