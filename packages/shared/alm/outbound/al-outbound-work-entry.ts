import { Temporal } from '@js-temporal/polyfill';

import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { fnv1a64, toAppQueueKey } from '../../queuebox/AppQueueIdentity.ts';
import { NonRetryableException } from '../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import {
    EntityStatus,
    isKeysEqual,
    toKeyAsString,
    type ResourceEntry
} from '../../queuebox/ResourceEntry.ts';
import { toError } from '../../resilience/to-error.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import { decodeALAdmissionRecord } from '../al-admission-value-validation.ts';
import type { ALWorkClaim, ALWorkQueuePort } from '../work/al-work-queue-port.ts';
import type {
    ALOutboundDurableEffect,
    ALOutboundEffectSnapshot
} from './admission/al-outbound-admission-store.ts';
import { decodeALOutboundEffectPayload, type ALOutboundPreparedRead } from './al-outbound-effect-validation.ts';

export const AL_OUTBOUND_WORK_LEASE_MS = 10_000;
export const AL_OUTBOUND_WORK_PAGE_SIZE = 16;

const AL_OUTBOUND_SCAN_STATUSES = [EntityStatus.NEW, EntityStatus.RETRY, EntityStatus.RESERVED] as const;

export interface ALOutboundWorkEntryInput<TPrepared> {
    readonly namespace: string;
    readonly effectId: string;
    readonly payload: ALOutboundDurableEffect<TPrepared>;
    readonly observedAtMs: number;
    readonly retryAtMs: number;
    readonly expireAtTimestamp: number;
}

export function toALOutboundWorkType(namespace: string): string {
    return `AL_OUTBOUND:${fnv1a64(namespace)}`;
}

export function toALOutboundWorkKey(namespace: string, effectId: string) {
    return toAppQueueKey({
        topicId: 'AL_OUTBOUND',
        resourceId: encodeURIComponent(namespace),
        contextId: encodeURIComponent(effectId)
    });
}

export function computeALOutboundWorkEntry<TPrepared>(input: ALOutboundWorkEntryInput<TPrepared>): ResourceEntry {
    const createdTs = Temporal.Instant.fromEpochMilliseconds(input.observedAtMs).toZonedDateTimeISO('UTC');
    return {
        key: toALOutboundWorkKey(input.namespace, input.effectId),
        typeId: toALOutboundWorkType(input.namespace),
        resource: JSON.stringify({
            namespace: input.namespace,
            effectId: input.effectId,
            payload: input.payload
        }),
        audit: {
            createdBy: 'ALM',
            createdTs: createdTs.toPlainDateTime(),
            date: createdTs.toPlainTime(),
            expiryTs: Temporal.Instant.fromEpochMilliseconds(input.expireAtTimestamp)
        },
        status: EntityStatus.NEW,
        dequeueAudit: { attempts: 0, nextTs: Temporal.Instant.fromEpochMilliseconds(input.retryAtMs) },
        db: undefined
    };
}

export function decodeALOutboundWorkEntry<TPrepared>(
    entry: ResourceEntry,
    namespace: string,
    preparedRead: ALOutboundPreparedRead<TPrepared>
): ALOutboundEffectSnapshot<TPrepared> {
    try {
        const raw: unknown = JSON.parse(entry.resource);
        const stored = decodeALAdmissionRecord(raw, ['namespace', 'effectId', 'payload']);
        if (stored.namespace !== namespace || typeof stored.effectId !== 'string' || stored.effectId.length === 0) {
            throw new TypeError('Outbound work identity differs from its admission scope');
        }
        if (
            entry.typeId !== toALOutboundWorkType(namespace) ||
            !isKeysEqual(entry.key, toALOutboundWorkKey(namespace, stored.effectId))
        ) {
            throw new TypeError('Outbound work identity differs from its queue slot');
        }
        const payload = decodeALOutboundEffectPayload(stored.payload, stored.effectId, preparedRead);
        if (
            (payload.kind === 'send-prepared' || payload.kind === 'admit-message') &&
            payload.message.expiresAtMs !== Number(entry.audit.expiryTs.epochMilliseconds)
        ) {
            throw new TypeError('Outbound work deadline differs from its canonical message reference');
        }
        return {
            effectId: stored.effectId,
            payload,
            canonicalMessage: preparedRead.message,
            entry,
            attempts: entry.dequeueAudit.attempts,
            retryAtMs: Number(
                entry.dequeueAudit.nextTs?.epochMilliseconds ??
                    entry.audit.createdTs.toZonedDateTime('UTC').epochMilliseconds
            ),
            expireAtTimestamp: Number(entry.audit.expiryTs.epochMilliseconds),
            leaseUntilMs: entry.status === EntityStatus.RESERVED
                ? resolveALOutboundWorkReadyAt(entry)
                : undefined
        };
    }
    catch (error) {
        throw new ALAdmissionCorruptionError(JSON.stringify(entry.key), toError(error));
    }
}

/** The foreign dequeue rows a tripped circuit gates, and the time it next allows one through. */
export interface ALOutboundDequeueDeferral {
    readonly types: ReadonlySet<string>;
    /** Epoch ms the breaker next admits a dequeue; undefined while it admits one now. */
    readonly readyAtMs: number | undefined;
}

/**
 * Retained and recovered work is due now, retried work at its own `nextTs`, gated dequeue work no
 * earlier than the breaker allows, and an expired row is never advertised. A page that still owes a
 * cursor and holds a due row answers `nowMs`: one status never hides the next. A cursor-owing page
 * whose visible rows are all expired or gated answers from those rows alone, so a full page of
 * expired rows advertises nothing and leaves the remainder to the queue's own expiry cleanup.
 */
export async function readALOutboundWorkReadyAt(
    port: ALWorkQueuePort,
    nowMs: number,
    deferral: ALOutboundDequeueDeferral
): Promise<number | undefined> {
    let readyAtMs: number | undefined;
    for (const status of AL_OUTBOUND_SCAN_STATUSES) {
        const page = await port.readPage({ status, maxToRead: AL_OUTBOUND_WORK_PAGE_SIZE, cursor: null });
        let hasDueEntry = false;
        for (const entry of page.entries) {
            if (entry.audit.expiryTs.epochMilliseconds <= nowMs) {
                continue;
            }
            const candidateAtMs = computeALOutboundEntryReadyAt(entry, nowMs, deferral);
            hasDueEntry ||= candidateAtMs <= nowMs;
            readyAtMs = Math.min(readyAtMs ?? candidateAtMs, candidateAtMs);
        }
        if (hasDueEntry && page.nextCursor !== null) {
            return nowMs;
        }
    }
    return readyAtMs;
}

function computeALOutboundEntryReadyAt(
    entry: ResourceEntry,
    nowMs: number,
    deferral: ALOutboundDequeueDeferral
): number {
    const readyAtMs = isUnleasedALOutboundReservation(entry) ? nowMs : resolveALOutboundWorkReadyAt(entry);
    return deferral.readyAtMs !== undefined && deferral.types.has(entry.typeId)
        ? Math.max(readyAtMs, deferral.readyAtMs)
        : readyAtMs;
}

/**
 * A reservation without a lease start can never time out, so the port can never re-reserve it; the
 * owner claims it as observed and the attempt rejects it.
 */
export async function readUnleasedALOutboundWorkClaims(
    port: ALWorkQueuePort,
    maxToRead: number,
    nowMs: number
): Promise<readonly ALWorkClaim[]> {
    const page = await port.readPage({ status: EntityStatus.RESERVED, maxToRead, cursor: null });
    return page.entries
        .filter(isUnleasedALOutboundReservation)
        .map((entry) => ({ entry, attempts: entry.dequeueAudit.attempts, leaseUntilMs: nowMs }));
}

function isUnleasedALOutboundReservation(entry: ResourceEntry): boolean {
    return entry.status === EntityStatus.RESERVED && entry.dequeueAudit.startTs === undefined;
}

/**
 * A row of a foreign dequeue type is work the outbound owner admits, not work it wrote: its identity
 * is the queue slot itself and its message is the queued payload.
 */
export function toALOutboundDequeueWork<TPrepared>(
    entry: ResourceEntry,
    readMessageFromEntry: (entry: ResourceEntry) => ALMessage
): ALOutboundEffectSnapshot<TPrepared> {
    return {
        effectId: toKeyAsString(entry.key),
        payload: { kind: 'dequeue-message', queueTypeId: entry.typeId },
        canonicalMessage: readALOutboundQueuedMessage(entry, readMessageFromEntry),
        entry,
        attempts: entry.dequeueAudit.attempts,
        retryAtMs: Number(
            entry.dequeueAudit.nextTs?.epochMilliseconds ??
                entry.audit.createdTs.toZonedDateTime('UTC').epochMilliseconds
        ),
        expireAtTimestamp: Number(entry.audit.expiryTs.epochMilliseconds),
        leaseUntilMs: entry.status === EntityStatus.RESERVED ? resolveALOutboundWorkReadyAt(entry) : undefined
    };
}

function readALOutboundQueuedMessage(
    entry: ResourceEntry,
    readMessageFromEntry: (entry: ResourceEntry) => ALMessage
): ALMessage {
    try {
        return readMessageFromEntry(entry);
    }
    catch (error) {
        if (error instanceof TypeError) {
            throw new NonRetryableException(error.message);
        }
        throw error;
    }
}

export function isPendingALOutboundWork(entry: ResourceEntry): boolean {
    return entry.status === EntityStatus.NEW || entry.status === EntityStatus.RETRY ||
        entry.status === EntityStatus.RESERVED;
}

export function resolveALOutboundWorkReadyAt(entry: ResourceEntry): number {
    if (entry.status === EntityStatus.RESERVED) {
        if (entry.dequeueAudit.startTs === undefined) {
            throw new TypeError('Outbound work reservation start is missing');
        }
        return Number(
            entry.dequeueAudit.startTs.round({ smallestUnit: 'millisecond', roundingMode: 'ceil' }).epochMilliseconds
        ) + AL_OUTBOUND_WORK_LEASE_MS;
    }
    return Number(
        entry.dequeueAudit.nextTs?.epochMilliseconds ??
            entry.audit.createdTs.toZonedDateTime('UTC').epochMilliseconds
    );
}
