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
import type { ALWorkLeaseSweepState } from '../work/al-work-lease-recovery.ts';
import type { ALWorkQueuePort } from '../work/al-work-queue-port.ts';
import { computeALWorkEntry } from '../work/compute-al-work-entry.ts';
import {
    readALWorkReadyAt,
    resolveALWorkEntryDueAtMs,
    resolveALWorkEntryReadyAt
} from '../work/read-al-work-ready-at.ts';
import type {
    ALOutboundDurableEffect,
    ALOutboundEffectSnapshot
} from './admission/al-outbound-admission-store.ts';
import { decodeALOutboundEffectPayload, type ALOutboundPreparedRead } from './al-outbound-effect-validation.ts';

export const AL_OUTBOUND_WORK_LEASE_MS = 10_000;
export const AL_OUTBOUND_WORK_PAGE_SIZE = 16;

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

/** The payload as stored: a send keeps its positions only once a recording read them, as an older build wrote it. */
function toALOutboundStoredEffectPayload<TPrepared>(
    payload: ALOutboundDurableEffect<TPrepared>
): ALOutboundDurableEffect<TPrepared> | Omit<ALOutboundDurableEffect<TPrepared>, 'sentPositions'> {
    if (payload.kind !== 'send-prepared' || payload.sentPositions !== null) {
        return payload;
    }
    const { sentPositions: _sentPositions, ...stored } = payload;
    return stored;
}

export function computeALOutboundWorkEntry<TPrepared>(input: ALOutboundWorkEntryInput<TPrepared>): ResourceEntry {
    return computeALWorkEntry({
        key: toALOutboundWorkKey(input.namespace, input.effectId),
        typeId: toALOutboundWorkType(input.namespace),
        resource: JSON.stringify({
            namespace: input.namespace,
            effectId: input.effectId,
            payload: toALOutboundStoredEffectPayload(input.payload)
        }),
        observedAtMs: input.observedAtMs,
        readyAtMs: input.retryAtMs,
        expireAtTimestamp: input.expireAtTimestamp
    });
}

export function decodeALOutboundWorkEntry<TPrepared>(
    entry: ResourceEntry,
    namespace: string,
    preparedRead: ALOutboundPreparedRead<TPrepared>
): ALOutboundEffectSnapshot<TPrepared> {
    try {
        const stored = decodeALAdmissionRecord(
            JSON.parse(entry.resource),
            ['namespace', 'effectId', 'payload']
        );
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
            retryAtMs: resolveALWorkEntryDueAtMs(entry),
            expireAtTimestamp: Number(entry.audit.expiryTs.epochMilliseconds),
            leaseUntilMs: entry.status === EntityStatus.RESERVED
                ? resolveALWorkEntryReadyAt(entry, AL_OUTBOUND_WORK_LEASE_MS)
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

/** What the lane's gates hold back from the readiness scan: an open dequeue circuit and a closed lease sweep. */
export interface ALOutboundWorkDeferral {
    readonly dequeue: ALOutboundDequeueDeferral;
    readonly leaseSweeps: ALWorkLeaseSweepState;
}

/** The outbound lane's readiness: the shared scan, with the dequeue circuit as the gate it holds rows to. */
export async function readALOutboundWorkReadyAt(
    port: ALWorkQueuePort,
    nowMs: number,
    deferral: ALOutboundWorkDeferral
): Promise<number | undefined> {
    return await readALWorkReadyAt(port, {
        nowMs,
        pageSize: AL_OUTBOUND_WORK_PAGE_SIZE,
        leaseMs: AL_OUTBOUND_WORK_LEASE_MS,
        leaseSweeps: deferral.leaseSweeps,
        readHeldUntilMs: (entry) => deferral.dequeue.types.has(entry.typeId) ? deferral.dequeue.readyAtMs : undefined
    });
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
        retryAtMs: resolveALWorkEntryDueAtMs(entry),
        expireAtTimestamp: Number(entry.audit.expiryTs.epochMilliseconds),
        leaseUntilMs: entry.status === EntityStatus.RESERVED
            ? resolveALWorkEntryReadyAt(entry, AL_OUTBOUND_WORK_LEASE_MS)
            : undefined
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
