import { Temporal } from '@js-temporal/polyfill';
import { isALControlTypeId } from '../../al-contracts/al-control.ts';
import { toALInboundPendingAdmissionId } from './al-inbound-pending-admission.ts';
import {
    decodeALInboundMessageReference,
    decodeALInboundSource
} from './al-inbound-source-validation.ts';

import { decodeALControlMessage } from '../../al-contracts/al-control.ts';
import {
    decodePersistedALMessageValue,
    type ALMessageRejection
} from '../../al-contracts/al-message-persistence-validation.ts';
import {
    decodePersistedALRecord,
    requirePersistedALFields,
    type PersistedALValue
} from '../../al-contracts/al-message-persistence/persisted-al-value-validation.ts';
import { fnv1a64, toAppQueueKey } from '../../queuebox/AppQueueIdentity.ts';
import { NonRetryableException } from '../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import {
    EntityStatus,
    isKeysEqual,
    type ResourceEntry
} from '../../queuebox/ResourceEntry.ts';
import { jsonEquals } from '../../repository/state-utils.ts';
import { Either } from '../../resilience/Either.ts';
import { toError } from '../../resilience/to-error.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import {
    decodeALAdmissionNumber,
    decodeALAdmissionRecord,
    decodeALAdmissionString
} from '../al-admission-value-validation.ts';
import type {
    ALInboundDurableEffect,
    ALInboundDurableEffectWrite,
    ALPersistedInboundEffect
} from './al-inbound-admission-store.ts';
import { decodeALInboundPlan } from './decode-al-inbound-plan.ts';

export const AL_INBOUND_WORK_LEASE_MS = 10_000;

export interface ALInboundWorkEntryInput {
    readonly namespace: string;
    readonly effectId: string;
    readonly payload: ALInboundDurableEffect;
    readonly observedAtMs: number;
    readonly expireAtTimestamp: number;
}

export function toALInboundWorkType(namespace: string): string {
    return `AL_INBOUND:${fnv1a64(namespace)}`;
}

export function toALInboundWorkKey(namespace: string, effectId: string) {
    return toAppQueueKey({
        topicId: 'AL_INBOUND',
        resourceId: encodeURIComponent(namespace),
        contextId: encodeURIComponent(effectId)
    });
}

/** Completes the encoded QueueBox value before admission enters its conditional write. */
export function computeALInboundWorkEntry(input: ALInboundWorkEntryInput): ALInboundDurableEffectWrite {
    const createdTs = Temporal.Instant.fromEpochMilliseconds(input.observedAtMs).toZonedDateTimeISO('UTC');
    return {
        effectId: input.effectId,
        payload: input.payload,
        expireAtTimestamp: input.expireAtTimestamp,
        entry: {
            key: toALInboundWorkKey(input.namespace, input.effectId),
            typeId: toALInboundWorkType(input.namespace),
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
            dequeueAudit: { attempts: 0, nextTs: Temporal.Instant.fromEpochMilliseconds(input.observedAtMs) },
            db: undefined
        }
    };
}

export function decodeALInboundWorkEntry(entry: ResourceEntry, namespace: string): ALPersistedInboundEffect {
    try {
        const stored = decodePersistedALRecord(entry.resource, 'inbound work');
        const fields = ['namespace', 'effectId', 'payload'];
        requirePersistedALFields(stored, fields, fields);
        const effectId = decodeALAdmissionString(stored.effectId);
        if (stored.namespace !== namespace || effectId.length === 0) {
            throw new TypeError('Inbound work identity differs from its admission scope');
        }
        if (
            entry.typeId !== toALInboundWorkType(namespace) ||
            !isKeysEqual(entry.key, toALInboundWorkKey(namespace, effectId))
        ) {
            throw new TypeError('Inbound work identity differs from its queue slot');
        }
        const payload = decodeInboundDurableEffect(stored.payload);
        if (
            payload.kind === 'admit-message' && (
                effectId !== toALInboundPendingAdmissionId(payload.msg) ||
                payload.msg.constraints?.expiresAtMs !== entry.audit.expiryTs.epochMilliseconds
            )
        ) {
            throw new TypeError('Pending inbound admission identity or deadline differs from its queue observation');
        }
        return {
            effectId,
            payload,
            entry,
            attempts: entry.dequeueAudit.attempts,
            retryAtMs: Number(
                entry.dequeueAudit.nextTs?.epochMilliseconds ??
                    entry.audit.createdTs.toZonedDateTime('UTC').epochMilliseconds
            ),
            expireAtTimestamp: Number(entry.audit.expiryTs.epochMilliseconds),
            leaseUntilMs: entry.status === EntityStatus.RESERVED ? resolveALInboundWorkReadyAt(entry) : undefined
        };
    }
    catch (error) {
        throw new ALAdmissionCorruptionError(JSON.stringify(entry.key), toError(error));
    }
}

export function resolveALInboundWorkReadyAt(entry: ResourceEntry): number {
    if (entry.status === EntityStatus.RESERVED) {
        if (entry.dequeueAudit.startTs === undefined) {
            throw new NonRetryableException('Inbound work reservation start is missing');
        }
        return Number(
            entry.dequeueAudit.startTs.round({ smallestUnit: 'millisecond', roundingMode: 'ceil' }).epochMilliseconds
        ) + AL_INBOUND_WORK_LEASE_MS;
    }
    return Number(
        entry.dequeueAudit.nextTs?.epochMilliseconds ?? entry.audit.createdTs.toZonedDateTime('UTC').epochMilliseconds
    );
}

function decodeInboundDurableEffect(value: PersistedALValue): ALInboundDurableEffect {
    const effect = decodeALAdmissionRecord(value, ['kind'], [
        'msg',
        'message',
        'plan',
        'fromPeerId',
        'trackKey',
        'seq',
        'source',
        'expiresAtMs'
    ]);
    switch (effect.kind) {
        case 'admit-message': {
            decodeALAdmissionRecord(effect, ['kind', 'msg', 'source']);
            const msg = decodePersistedALMessageValue(effect.msg);
            if (msg.payload.typeId.startsWith('al.control.') || isALControlTypeId(msg.payload.typeId)) {
                throw new TypeError('Pending inbound admission cannot own a control message');
            }
            return { kind: effect.kind, msg, source: decodeALInboundSource(effect.source) };
        }
        case 'dispatch-local': {
            decodeALAdmissionRecord(effect, ['kind', 'message']);
            return { kind: effect.kind, message: decodeALInboundMessageReference(effect.message) };
        }
        case 'admit-control': {
            decodeALAdmissionRecord(effect, ['kind', 'msg', 'expiresAtMs']);
            const msg = decodePersistedALMessageValue(effect.msg);
            const validated = decodeALControlMessage(msg);
            if (validated.left) {
                throw new TypeError(validated.left.message);
            }
            return { kind: effect.kind, msg, expiresAtMs: decodeALAdmissionNumber(effect.expiresAtMs) };
        }
        case 'send-control': {
            decodeALAdmissionRecord(effect, ['kind', 'msg']);
            const msg = decodePersistedALMessageValue(effect.msg);
            const validated = decodeALControlMessage(msg);
            if (validated.left) {
                throw new TypeError(validated.left.message);
            }
            return { kind: effect.kind, msg };
        }
        case 'forward-message': {
            decodeALAdmissionRecord(effect, ['kind', 'message', 'fromPeerId', 'plan']);
            return {
                kind: effect.kind,
                message: decodeALInboundMessageReference(effect.message),
                fromPeerId: decodeALAdmissionString(effect.fromPeerId),
                plan: decodeALInboundPlan(effect.plan)
            };
        }
        case 'release-buffered':
            decodeALAdmissionRecord(effect, ['kind', 'trackKey', 'seq']);
            return {
                kind: effect.kind,
                trackKey: decodeALAdmissionString(effect.trackKey),
                seq: decodeALAdmissionNumber(effect.seq)
            };
        default:
            throw new TypeError('Persisted inbound effect payload kind is invalid');
    }
}

export function validateALInboundWorkWrites(
    effects: readonly ALInboundDurableEffectWrite[],
    namespace: string
): Either<ALMessageRejection, readonly ALInboundDurableEffectWrite[]> {
    const effectIds = new Set<string>();
    for (const effect of effects) {
        if (effectIds.has(effect.effectId) || !Number.isSafeInteger(effect.expireAtTimestamp)) {
            return Either.ofLeft({
                code: 'malformed',
                message: 'Inbound admission candidate has invalid durable effect ownership'
            });
        }
        try {
            const stored = decodeALInboundWorkEntry(effect.entry, namespace);
            if (
                stored.effectId !== effect.effectId || !jsonEquals(stored.payload, effect.payload) ||
                stored.expireAtTimestamp !== effect.expireAtTimestamp || effect.entry.status !== EntityStatus.NEW ||
                effect.entry.dequeueAudit.attempts !== 0 || effect.entry.dequeueAudit.startTs !== undefined ||
                effect.entry.dequeueAudit.endTs !== undefined
            ) {
                return Either.ofLeft({
                    code: 'malformed',
                    message: 'Inbound admission work differs from its computed value'
                });
            }
        }
        catch {
            return Either.ofLeft({
                code: 'malformed',
                message: 'Inbound admission work is malformed or outside its namespace'
            });
        }
        effectIds.add(effect.effectId);
    }
    return Either.ofRight(effects);
}
