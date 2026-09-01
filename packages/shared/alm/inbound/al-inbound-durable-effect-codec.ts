import type { ALMessage } from '../../al-contracts/al-contract.ts';
import {
    AL_CONTROL_ACK_TYPE_ID,
    AL_CONTROL_NACK_TYPE_ID,
    AL_CONTROL_REPAIR_TYPE_ID,
    type ALAckPayload,
    type ALNackPayload,
    type ALRepairPayload
} from '../../al-contracts/al-control.ts';
import {
    decodePersistedALMessage,
    decodePersistedALMessageValue
} from '../../al-contracts/al-message-persistence-validation.ts';
import type { PersistedALValue } from '../../al-contracts/al-message-persistence/persisted-al-value-validation.ts';
import {
    decodeALAdmissionResourceEntry,
    encodeALAdmissionResourceEntry,
    type StoredALAdmissionResourceEntry
} from '../al-admission-resource-entry-validation.ts';
import {
    decodeALAdmissionControlValue,
    decodeALAdmissionNumber,
    decodeALAdmissionRecord,
    decodeALAdmissionString
} from '../al-admission-value-validation.ts';
import type { ALInboundDurableEffect, ALPersistedInboundEffect } from './al-inbound-admission-store.ts';
import { decodeALInboundPlan } from './decode-al-inbound-plan.ts';

type StoredALInboundDurableEffect =
    | Readonly<{
        kind: 'dispatch-local';
        entry: StoredALAdmissionResourceEntry;
    }>
    | Readonly<{
        kind: 'enqueue-inbox';
        entry: StoredALAdmissionResourceEntry;
    }>
    | Extract<ALInboundDurableEffect, Readonly<{ kind: 'send-control'; }>>
    | Extract<ALInboundDurableEffect, Readonly<{ kind: 'forward-message'; }>>
    | Extract<ALInboundDurableEffect, Readonly<{ kind: 'release-buffered'; }>>;

export interface StoredALPersistedInboundEffect extends Omit<ALPersistedInboundEffect, 'payload'> {
    readonly payload: StoredALInboundDurableEffect;
}

export function toStoredPersistedInboundEffect(
    effect: ALPersistedInboundEffect
): StoredALPersistedInboundEffect {
    return {
        ...effect,
        payload: toStoredInboundDurableEffect(effect.payload)
    };
}

export function decodeALPersistedInboundEffect(value: unknown, expectedEffectId: string): ALPersistedInboundEffect {
    const effect = decodeALAdmissionRecord(value, [
        'effectId',
        'payload',
        'status',
        'attempts',
        'retryAtMs',
        'updatedAtMs',
        'expireAtTimestamp'
    ], ['leaseOwner', 'leaseUntilMs', 'lastError']);
    const effectId = decodeALAdmissionString(effect.effectId);
    if (effectId !== expectedEffectId) {
        throw new TypeError('Persisted inbound effect does not match its storage slot');
    }
    if (effect.status !== 'pending' && effect.status !== 'running') {
        throw new TypeError('Persisted inbound effect status is invalid');
    }
    const leaseOwner = effect.leaseOwner === undefined ? undefined : decodeALAdmissionString(effect.leaseOwner);
    const leaseUntilMs = effect.leaseUntilMs === undefined ? undefined : decodeALAdmissionNumber(effect.leaseUntilMs);
    if (effect.status === 'running' && (leaseOwner === undefined || leaseUntilMs === undefined)) {
        throw new TypeError('Persisted running inbound effect has no complete lease');
    }
    if (effect.status === 'pending' && (leaseOwner !== undefined || leaseUntilMs !== undefined)) {
        throw new TypeError('Persisted pending inbound effect unexpectedly has a lease');
    }
    if (effect.lastError !== undefined && typeof effect.lastError !== 'string') {
        throw new TypeError('Persisted inbound effect error must be a string');
    }
    return {
        effectId,
        payload: decodeInboundDurableEffect(effect.payload),
        status: effect.status,
        attempts: decodeALAdmissionNumber(effect.attempts),
        retryAtMs: decodeALAdmissionNumber(effect.retryAtMs),
        updatedAtMs: decodeALAdmissionNumber(effect.updatedAtMs),
        expireAtTimestamp: decodeALAdmissionNumber(effect.expireAtTimestamp),
        leaseOwner,
        leaseUntilMs,
        lastError: effect.lastError
    };
}

function toStoredInboundDurableEffect(
    effect: ALInboundDurableEffect
): StoredALInboundDurableEffect {
    switch (effect.kind) {
        case 'dispatch-local':
        case 'enqueue-inbox':
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
        case 'dispatch-local':
        case 'enqueue-inbox': {
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
            assertControlMessage(msg);
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

function assertControlMessage(msg: ALMessage): void {
    const raw: unknown = JSON.parse(msg.payload.resource);
    const routeSuffix = `:${msg.payload.typeId}`;
    if (!msg.route.resourceId.endsWith(routeSuffix)) {
        throw new TypeError('Persisted inbound control route has the wrong type');
    }
    const expectedMsgId = msg.route.resourceId.slice(0, -routeSuffix.length);
    let payload: ALAckPayload | ALNackPayload | ALRepairPayload | undefined;
    switch (msg.payload.typeId) {
        case AL_CONTROL_ACK_TYPE_ID:
            payload = decodeALAdmissionControlValue({ kind: 'acks', values: [raw] }, expectedMsgId, 'acks').values[0];
            break;
        case AL_CONTROL_NACK_TYPE_ID:
            payload = decodeALAdmissionControlValue({ kind: 'nacks', values: [raw] }, expectedMsgId, 'nacks').values[0];
            break;
        case AL_CONTROL_REPAIR_TYPE_ID:
            payload =
                decodeALAdmissionControlValue({ kind: 'repairs', values: [raw] }, expectedMsgId, 'repairs').values[0];
            break;
        default:
            throw new TypeError('Persisted inbound control effect contains no control message');
    }
    if (
        !payload || payload.fromPeerId !== msg.id.senderId || msg.targets?.mode !== 'unicast' ||
        payload.toPeerId !== msg.targets.toPeerId
    ) {
        throw new TypeError('Persisted inbound control routing does not match its envelope');
    }
}
