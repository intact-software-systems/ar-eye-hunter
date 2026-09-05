import { Either } from '../resilience/Either.ts';
import type { ALMessage } from './al-contract.ts';

import { assertPersistedALDelivery } from './al-message-persistence/assert-persisted-al-delivery.ts';
import { assertPersistedALQos } from './al-message-persistence/assert-persisted-al-qos.ts';
import { assertPersistedALTargets } from './al-message-persistence/assert-persisted-al-targets.ts';
import {
    requireOptionalPersistedALNonEmptyString,
    requireOptionalPersistedALSafeInteger,
    requireOptionalPersistedALStringArray,
    requirePersistedALFields,
    requirePersistedALNonEmptyString,
    requirePersistedALRecord,
    requirePersistedALSafeInteger,
    type PersistedALRecord,
    type PersistedALValue
} from './al-message-persistence/persisted-al-value-validation.ts';
import { validateALMessageResourceLimits, validateSerializedALMessageSize } from './al-message-resource-limits.ts';

export interface ALMessageRejection {
    readonly code: 'malformed' | 'oversized' | 'unauthorized' | 'unsupported';
    readonly message: string;
}

const MESSAGE_SECTIONS = [
    'id',
    'route',
    'targets',
    'forwarding',
    'constraints',
    'ordering',
    'delivery',
    'actions',
    'qos',
    'payload',
    'audit',
    'diagnostics'
] as const;

export function decodeALMessageValue(value: unknown): Either<ALMessageRejection, ALMessage> {
    try {
        const resourceIssues = validateALMessageResourceLimits(value);
        if (resourceIssues.length > 0) {
            return Either.ofLeft(resourceIssues[0]);
        }
        if (
            !value || typeof value !== 'object' || Array.isArray(value) ||
            Object.getPrototypeOf(value) !== Object.prototype
        ) {
            return Either.ofLeft({ code: 'malformed', message: 'AL envelope must be a plain object' });
        }
        const message = value as PersistedALRecord;
        requirePersistedALFields(message, MESSAGE_SECTIONS, ['id', 'route', 'payload']);
        const id = requirePersistedALRecord(message.id, 'id');
        if (typeof id.v === 'number' && id.v !== 2) {
            return Either.ofLeft({ code: 'unsupported', message: 'AL envelope version is unsupported' });
        }
        assertId(message.id);
        assertRoute(message.route);
        assertPayload(message.payload);
        assertRoutingSections(message);
        assertDeliverySections(message);
        assertProvenanceSections(message);
        return Either.ofRight(value as ALMessage);
    }
    catch (error) {
        return Either.ofLeft({
            code: 'malformed',
            message: error instanceof TypeError ? error.message : 'AL envelope is malformed'
        });
    }
}

export function decodeALMessage(serialized: string): Either<ALMessageRejection, ALMessage> {
    const resourceIssues = validateSerializedALMessageSize(serialized);
    if (resourceIssues.length > 0) {
        return Either.ofLeft(resourceIssues[0]);
    }
    let value: unknown;
    try {
        value = JSON.parse(serialized);
    }
    catch {
        return Either.ofLeft({ code: 'malformed', message: 'AL envelope must contain valid JSON' });
    }
    return decodeALMessageValue(value);
}

/** Persisted invalid envelopes are invariant corruption, not a recoverable live-ingress rejection. */
export function decodePersistedALMessageValue(value: unknown): ALMessage {
    return decodeALMessageValue(value).fold(throwPersistedALMessageCorruption, (message) => message);
}

export function decodePersistedALMessage(serialized: string): ALMessage {
    return decodeALMessage(serialized).fold(throwPersistedALMessageCorruption, (message) => message);
}

function assertRoutingSections(message: PersistedALRecord): void {
    if (message.targets !== undefined) {
        assertPersistedALTargets(message.targets);
    }
    if (message.forwarding !== undefined) {
        const section = requirePersistedALRecord(message.forwarding, 'forwarding');
        requirePersistedALFields(section, ['nextHopPeerIds', 'overlayId', 'fanoutLimit'], []);
        requireOptionalPersistedALStringArray(section.nextHopPeerIds, 'forwarding next hops');
        requireOptionalPersistedALNonEmptyString(section.overlayId, 'forwarding overlay id');
        requireOptionalPersistedALSafeInteger(section.fanoutLimit, 1, 'forwarding fanout limit');
    }
    if (message.constraints !== undefined) {
        const section = requirePersistedALRecord(message.constraints, 'constraints');
        requirePersistedALFields(section, ['ttlHops', 'expiresAtMs'], []);
        requireOptionalPersistedALSafeInteger(section.ttlHops, 0, 'constraint hop ttl');
        requireOptionalPersistedALSafeInteger(section.expiresAtMs, 0, 'constraint expiry');
    }
}

function assertDeliverySections(message: PersistedALRecord): void {
    if (message.ordering !== undefined) {
        const section = requirePersistedALRecord(message.ordering, 'ordering');
        requirePersistedALFields(section, ['orderingKey', 'epoch', 'seq'], []);
        requireOptionalPersistedALNonEmptyString(section.orderingKey, 'ordering key');
        requireOptionalPersistedALSafeInteger(section.epoch, 0, 'ordering epoch');
        requireOptionalPersistedALSafeInteger(section.seq, 0, 'ordering sequence');
    }
    if (message.delivery !== undefined) {
        assertPersistedALDelivery(message.delivery);
    }
    if (message.qos !== undefined) {
        assertPersistedALQos(message.qos);
    }
}

function assertProvenanceSections(message: PersistedALRecord): void {
    if (message.actions !== undefined) {
        const section = requirePersistedALRecord(message.actions, 'actions');
        requirePersistedALFields(section, ['corrId', 'replyToMsgId'], []);
        requireOptionalPersistedALNonEmptyString(section.corrId, 'action correlation id');
        requireOptionalPersistedALNonEmptyString(section.replyToMsgId, 'action reply id');
    }
    if (message.audit !== undefined) {
        const section = requirePersistedALRecord(message.audit, 'audit');
        requirePersistedALFields(section, ['createdBy', 'createdTs'], []);
        requireOptionalPersistedALNonEmptyString(section.createdBy, 'audit creator');
        requireOptionalPersistedALSafeInteger(section.createdTs, 0, 'audit creation time');
    }
    if (message.diagnostics !== undefined) {
        const section = requirePersistedALRecord(message.diagnostics, 'diagnostics');
        requirePersistedALFields(section, ['visitedPeerIds'], []);
        requireOptionalPersistedALStringArray(section.visitedPeerIds, 'diagnostic visited peers');
    }
}

function assertId(value: PersistedALValue): void {
    const id = requirePersistedALRecord(value, 'id');
    requirePersistedALFields(id, ['v', 'msgId', 'ts', 'senderId', 'sessionId', 'traceId'], [
        'v',
        'msgId',
        'ts',
        'senderId'
    ]);
    if (id.v !== 2) {
        throw new TypeError('Persisted AL id version is invalid');
    }
    requirePersistedALNonEmptyString(id.msgId, 'id message id');
    requirePersistedALSafeInteger(id.ts, 0, 'id timestamp');
    requirePersistedALNonEmptyString(id.senderId, 'id sender');
    requireOptionalPersistedALNonEmptyString(id.sessionId, 'id session');
    requireOptionalPersistedALNonEmptyString(id.traceId, 'id trace');
}

function assertRoute(value: PersistedALValue): void {
    const route = requirePersistedALRecord(value, 'route');
    requirePersistedALFields(route, ['topicId', 'resourceId', 'contextId'], ['topicId', 'resourceId', 'contextId']);
    requirePersistedALNonEmptyString(route.topicId, 'route topic');
    requirePersistedALNonEmptyString(route.resourceId, 'route resource');
    requirePersistedALNonEmptyString(route.contextId, 'route context');
}

function assertPayload(value: PersistedALValue): void {
    const payload = requirePersistedALRecord(value, 'payload');
    requirePersistedALFields(payload, ['typeId', 'contentType', 'resource'], ['typeId', 'resource']);
    requirePersistedALNonEmptyString(payload.typeId, 'payload type');
    requirePersistedALNonEmptyString(payload.resource, 'payload resource');
    if (payload.contentType !== undefined && payload.contentType !== 'application/json') {
        throw new TypeError('Persisted AL payload content type is invalid');
    }
}

function throwPersistedALMessageCorruption(rejection: ALMessageRejection): never {
    throw new TypeError(rejection.message);
}
