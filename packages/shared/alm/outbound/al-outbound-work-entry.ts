import { Temporal } from '@js-temporal/polyfill';

import { fnv1a64, toAppQueueKey } from '../../queuebox/AppQueueIdentity.ts';
import { EntityStatus, isKeysEqual, type ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { toError } from '../../resilience/to-error.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import { decodeALAdmissionRecord } from '../al-admission-value-validation.ts';
import type {
    ALOutboundDurableEffect,
    ALOutboundEffectSnapshot,
    ALOutboundPreparedMessageDecoder
} from './al-outbound-admission-store.ts';
import { decodeALOutboundEffectPayload, encodeALOutboundEffectPayload } from './al-outbound-effect-validation.ts';

export const AL_OUTBOUND_WORK_LEASE_MS = 10_000;

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
        resourceId: encodeURIComponent(effectId),
        contextId: encodeURIComponent(namespace)
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
            payload: encodeALOutboundEffectPayload(input.payload)
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
    decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
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
        return {
            effectId: stored.effectId,
            payload: decodeALOutboundEffectPayload(stored.payload, stored.effectId, decodePrepared),
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
