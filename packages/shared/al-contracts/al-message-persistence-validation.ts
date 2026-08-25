import type { ALMessage } from '@shared/al-contracts/al-contract.ts';

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
import {
    validatePersistedALDelivery,
    validatePersistedALQos
} from './al-message-persistence/validate-persisted-al-delivery-and-qos.ts';
import { validatePersistedALTargets } from './al-message-persistence/validate-persisted-al-targets.ts';

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

/** Validates the complete persisted AL envelope without imposing topic semantics. */
export function validatePersistedALMessage(
    value: unknown
): asserts value is ALMessage {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Persisted AL message is invalid');
    }
    const message = value as PersistedALRecord;
    requirePersistedALFields(message, MESSAGE_SECTIONS, ['id', 'route', 'payload']);
    validateId(message.id);
    validateRoute(message.route);
    validatePayload(message.payload);
    if (message.targets !== undefined) {
        validatePersistedALTargets(message.targets);
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
    if (message.ordering !== undefined) {
        const section = requirePersistedALRecord(message.ordering, 'ordering');
        requirePersistedALFields(section, ['orderingKey', 'epoch', 'seq'], []);
        requireOptionalPersistedALNonEmptyString(section.orderingKey, 'ordering key');
        requireOptionalPersistedALSafeInteger(section.epoch, 0, 'ordering epoch');
        requireOptionalPersistedALSafeInteger(section.seq, 0, 'ordering sequence');
    }
    if (message.delivery !== undefined) {
        validatePersistedALDelivery(message.delivery);
    }
    if (message.actions !== undefined) {
        const section = requirePersistedALRecord(message.actions, 'actions');
        requirePersistedALFields(section, ['corrId', 'replyToMsgId'], []);
        requireOptionalPersistedALNonEmptyString(section.corrId, 'action correlation id');
        requireOptionalPersistedALNonEmptyString(section.replyToMsgId, 'action reply id');
    }
    if (message.qos !== undefined) {
        validatePersistedALQos(message.qos);
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

export function decodePersistedALMessage(serialized: string): ALMessage {
    const value = JSON.parse(serialized);
    validatePersistedALMessage(value);
    return value;
}

function validateId(value: PersistedALValue): void {
    const id = requirePersistedALRecord(value, 'id');
    requirePersistedALFields(
        id,
        ['v', 'msgId', 'ts', 'senderId', 'sessionId', 'traceId'],
        ['v', 'msgId', 'ts', 'senderId']
    );
    if (id.v !== 2) {
        throw new TypeError('Persisted AL id version is invalid');
    }
    requirePersistedALNonEmptyString(id.msgId, 'id message id');
    requirePersistedALSafeInteger(id.ts, 0, 'id timestamp');
    requirePersistedALNonEmptyString(id.senderId, 'id sender');
    requireOptionalPersistedALNonEmptyString(id.sessionId, 'id session');
    requireOptionalPersistedALNonEmptyString(id.traceId, 'id trace');
}

function validateRoute(value: PersistedALValue): void {
    const route = requirePersistedALRecord(value, 'route');
    requirePersistedALFields(
        route,
        ['topicId', 'resourceId', 'contextId'],
        ['topicId', 'resourceId', 'contextId']
    );
    requirePersistedALNonEmptyString(route.topicId, 'route topic');
    requirePersistedALNonEmptyString(route.resourceId, 'route resource');
    requirePersistedALNonEmptyString(route.contextId, 'route context');
}

function validatePayload(value: PersistedALValue): void {
    const payload = requirePersistedALRecord(value, 'payload');
    requirePersistedALFields(
        payload,
        ['typeId', 'contentType', 'resource'],
        ['typeId', 'resource']
    );
    requirePersistedALNonEmptyString(payload.typeId, 'payload type');
    requirePersistedALNonEmptyString(payload.resource, 'payload resource');
    if (payload.contentType !== undefined && payload.contentType !== 'application/json') {
        throw new TypeError('Persisted AL payload content type is invalid');
    }
}
