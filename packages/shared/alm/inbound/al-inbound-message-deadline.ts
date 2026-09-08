import { Temporal } from '@js-temporal/polyfill';
import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';

export function toALInboundMessageWithDeadline(msg: ALMessage, expireAtTimestamp: number): ALMessage {
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
