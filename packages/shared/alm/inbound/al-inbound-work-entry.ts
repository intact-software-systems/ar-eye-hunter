import { Temporal } from '@js-temporal/polyfill';

import { decodeALControlMessage } from '../../al-contracts/al-control.ts';
import {
    decodePersistedALMessage,
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
import { EntityStatus, isKeysEqual, type ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { jsonEquals } from '../../repository/state-utils.ts';
import { Either } from '../../resilience/Either.ts';
import { toError } from '../../resilience/to-error.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import {
    decodeALAdmissionResourceEntry,
    encodeALAdmissionResourceEntry,
    type StoredALAdmissionResourceEntry
} from '../al-admission-resource-entry-validation.ts';
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

type StoredALInboundDurableEffect =
    | Readonly<{
        kind: 'dispatch-local';
        entry: StoredALAdmissionResourceEntry;
    }>
    | Extract<ALInboundDurableEffect, Readonly<{ kind: 'send-control'; }>>
    | Extract<ALInboundDurableEffect, Readonly<{ kind: 'forward-message'; }>>
    | Extract<ALInboundDurableEffect, Readonly<{ kind: 'release-buffered'; }>>;

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
        resourceId: encodeURIComponent(effectId),
        contextId: encodeURIComponent(namespace)
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
                payload: toStoredInboundDurableEffect(input.payload)
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
        return {
            effectId,
            payload: decodeInboundDurableEffect(stored.payload),
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

function toStoredInboundDurableEffect(
    effect: ALInboundDurableEffect
): StoredALInboundDurableEffect {
    switch (effect.kind) {
        case 'dispatch-local':
            return {
                ...effect,
                entry: encodeALAdmissionResourceEntry(effect.entry)
            };
        case 'send-control':
        case 'forward-message':
        case 'release-buffered':
            return effect;
    }
}

function decodeInboundDurableEffect(value: PersistedALValue): ALInboundDurableEffect {
    const effect = decodeALAdmissionRecord(value, ['kind'], ['msg', 'entry', 'plan', 'fromPeerId', 'trackKey', 'seq']);
    switch (effect.kind) {
        case 'dispatch-local': {
            decodeALAdmissionRecord(effect, ['kind', 'entry']);
            const entry = decodeALAdmissionResourceEntry(effect.entry);
            const message = decodePersistedALMessage(entry.resource);
            if (
                entry.key.topicId !== message.route.topicId || entry.key.resourceId !== message.route.resourceId ||
                entry.key.contextId !== message.route.contextId
            ) {
                throw new TypeError('Persisted inbound queue entry route does not match its embedded message');
            }
            return { kind: effect.kind, entry };
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
            decodeALAdmissionRecord(effect, ['kind', 'msg', 'fromPeerId', 'plan']);
            return {
                kind: effect.kind,
                msg: decodePersistedALMessageValue(effect.msg),
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
