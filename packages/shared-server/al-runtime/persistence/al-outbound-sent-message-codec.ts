import type { ALOutboundSentMessageSnapshot } from '@shared/alm/ALRuntimeStateStores.ts';
import type { JsonWireValue } from '../../rallar-system/protocol/json-wire-identity.ts';
import {
    createALJsonPersistenceCodec,
    hasOnlyKeys,
    isFiniteNumber,
    isJsonWireRecord,
    isOneOf,
    isOptionalFiniteNumber,
    isOptionalString,
    isOptionalStringArray,
    isRecord,
    isString
} from './al-json-persistence-codec.ts';

export const alOutboundSentMessageCodec = createALJsonPersistenceCodec<ALOutboundSentMessageSnapshot>(
    'AL outbound sent-message snapshot',
    decodeALOutboundSentMessageSnapshot
);

function decodeALOutboundSentMessageSnapshot(
    input: JsonWireValue
): ALOutboundSentMessageSnapshot {
    if (!isALOutboundSentMessageSnapshot(input)) {
        throw new TypeError(
            'Stored AL outbound sent-message snapshot does not match the current contract'
        );
    }
    return input;
}

function isALOutboundSentMessageSnapshot(
    input: JsonWireValue | object
): input is ALOutboundSentMessageSnapshot {
    return isRecord(input) &&
        hasOnlyKeys(input, ['msgId', 'msg', 'outboxKey', 'supersedenceKey']) &&
        isString(input.msgId) &&
        isALMessage(input.msg) &&
        (input.outboxKey === undefined || isResourceKey(input.outboxKey)) &&
        isOptionalString(input.supersedenceKey);
}

function isALMessage(input: JsonWireValue | undefined): boolean {
    return isRecord(input) &&
        hasOnlyKeys(input, [
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
        ]) &&
        isALMessageId(input.id) &&
        isALRoute(input.route) &&
        (input.targets === undefined || isALTargets(input.targets)) &&
        (input.forwarding === undefined || isALForwarding(input.forwarding)) &&
        (input.constraints === undefined || isALConstraints(input.constraints)) &&
        (input.ordering === undefined || isALOrdering(input.ordering)) &&
        (input.delivery === undefined || isALDelivery(input.delivery)) &&
        (input.actions === undefined || isALActions(input.actions)) &&
        (input.qos === undefined || isALQosRequest(input.qos)) &&
        isALPayload(input.payload) &&
        (input.audit === undefined || isALAudit(input.audit)) &&
        (input.diagnostics === undefined || isALDiagnostics(input.diagnostics));
}

function isALMessageId(input: JsonWireValue | undefined): boolean {
    return isRecord(input) &&
        hasOnlyKeys(input, ['v', 'msgId', 'ts', 'senderId', 'sessionId', 'traceId']) &&
        input.v === 2 &&
        isString(input.msgId) &&
        isFiniteNumber(input.ts) &&
        isString(input.senderId) &&
        isOptionalString(input.sessionId) &&
        isOptionalString(input.traceId);
}

function isALRoute(input: JsonWireValue | undefined): boolean {
    return isRecord(input) &&
        hasOnlyKeys(input, ['topicId', 'resourceId', 'contextId']) &&
        isString(input.topicId) &&
        isString(input.resourceId) &&
        isString(input.contextId);
}

function isALTargets(input: JsonWireValue | undefined): boolean {
    if (!isRecord(input)) {
        return false;
    }
    if (input.mode === 'unicast') {
        return hasOnlyKeys(input, ['mode', 'toPeerId']) && isString(input.toPeerId);
    }
    if (input.mode === 'multicast') {
        return hasOnlyKeys(input, ['mode', 'groupRef', 'membershipEpoch', 'minSnapshotVersion']) &&
            isGroupRef(input.groupRef) &&
            isOptionalFiniteNumber(input.membershipEpoch) &&
            isOptionalFiniteNumber(input.minSnapshotVersion);
    }
    return input.mode === 'broadcast' &&
        hasOnlyKeys(input, [
            'mode',
            'scope',
            'groupRef',
            'principalRef',
            'exceptPeerIds',
            'minSnapshotVersion',
            'recipientPeerIds'
        ]) &&
        isOneOf(input.scope, ['room', 'world', 'all', 'principal']) &&
        (input.groupRef === undefined || isGroupRef(input.groupRef)) &&
        (input.principalRef === undefined || isPrincipalRef(input.principalRef)) &&
        isOptionalStringArray(input.exceptPeerIds) &&
        isOptionalFiniteNumber(input.minSnapshotVersion) &&
        isOptionalStringArray(input.recipientPeerIds);
}

function isALForwarding(input: JsonWireValue | undefined): boolean {
    return isRecord(input) &&
        hasOnlyKeys(input, ['nextHopPeerIds', 'overlayId', 'fanoutLimit']) &&
        isOptionalStringArray(input.nextHopPeerIds) &&
        isOptionalString(input.overlayId) &&
        isOptionalFiniteNumber(input.fanoutLimit);
}

function isALConstraints(input: JsonWireValue | undefined): boolean {
    return isRecord(input) &&
        hasOnlyKeys(input, ['ttlHops', 'expiresAtMs']) &&
        isOptionalFiniteNumber(input.ttlHops) &&
        isOptionalFiniteNumber(input.expiresAtMs);
}

function isALOrdering(input: JsonWireValue | undefined): boolean {
    return isRecord(input) &&
        hasOnlyKeys(input, ['orderingKey', 'epoch', 'seq']) &&
        isOptionalString(input.orderingKey) &&
        isOptionalFiniteNumber(input.epoch) &&
        isOptionalFiniteNumber(input.seq);
}

function isALDelivery(input: JsonWireValue | undefined): boolean {
    return isRecord(input) &&
        hasOnlyKeys(input, ['ownership', 'reliability', 'ack']) &&
        (input.ownership === undefined || isOneOf(input.ownership, ['shared', 'exclusive'])) &&
        isOneOf(input.reliability, ['best-effort', 'at-least-once']) &&
        isOneOf(input.ack, ['none', 'receiver', 'all-logical-recipients', 'group-leader']);
}

function isALActions(input: JsonWireValue | undefined): boolean {
    return isRecord(input) &&
        hasOnlyKeys(input, ['corrId', 'replyToMsgId']) &&
        isOptionalString(input.corrId) &&
        isOptionalString(input.replyToMsgId);
}

function isALQosRequest(input: JsonWireValue | undefined): boolean {
    if (!isRecord(input) || !hasOnlyKeys(input, Object.keys(AL_QOS_ALGORITHMS))) {
        return false;
    }
    return Object.entries(input).every(([aspect, request]) => {
        const allowedAlgorithms = AL_QOS_ALGORITHMS[aspect];
        return allowedAlgorithms !== undefined &&
            isRecord(request) &&
            hasOnlyKeys(request, ['algo', 'opts']) &&
            isOneOf(request.algo, allowedAlgorithms) &&
            (request.opts === undefined || isJsonWireRecord(request.opts));
    });
}

function isALPayload(input: JsonWireValue | undefined): boolean {
    return isRecord(input) &&
        hasOnlyKeys(input, ['typeId', 'contentType', 'resource']) &&
        isString(input.typeId) &&
        (input.contentType === undefined || input.contentType === 'application/json') &&
        isString(input.resource);
}

function isALAudit(input: JsonWireValue | undefined): boolean {
    return isRecord(input) &&
        hasOnlyKeys(input, ['createdBy', 'createdTs']) &&
        isOptionalString(input.createdBy) &&
        isOptionalFiniteNumber(input.createdTs);
}

function isALDiagnostics(input: JsonWireValue | undefined): boolean {
    return isRecord(input) &&
        hasOnlyKeys(input, ['visitedPeerIds']) &&
        isOptionalStringArray(input.visitedPeerIds);
}

function isGroupRef(input: JsonWireValue | undefined): boolean {
    return isRecord(input) &&
        hasOnlyKeys(input, ['applicationId', 'workspaceId', 'groupId']) &&
        isString(input.applicationId) &&
        isString(input.workspaceId) &&
        isString(input.groupId);
}

function isPrincipalRef(input: JsonWireValue | undefined): boolean {
    return isRecord(input) &&
        hasOnlyKeys(input, ['applicationId', 'workspaceId', 'principalId']) &&
        isString(input.applicationId) &&
        isString(input.workspaceId) &&
        isString(input.principalId);
}

function isResourceKey(input: JsonWireValue | undefined): boolean {
    return isRecord(input) &&
        hasOnlyKeys(input, ['topicId', 'resourceId', 'contextId']) &&
        isString(input.topicId) &&
        isString(input.resourceId) &&
        isString(input.contextId);
}

const AL_QOS_ALGORITHMS: Readonly<Record<string, readonly string[]>> = {
    delivery: ['best-effort', 'at-least-once'],
    forwarding: ['target'],
    repair: ['none', 'retransmit'],
    ack: ['none', 'hop', 'subtree'],
    expiry: ['ttl-only', 'expires-at', 'fresh-until'],
    retry: ['none', 'exp-backoff'],
    dedup: ['msg-id', 'msg-id+sender', 'semantic-key'],
    supersedence: ['none', 'latest-wins'],
    fanout: ['all', 'limit', 'random-k'],
    congestion: ['drop-low', 'defer', 'reject'],
    durability: ['volatile', 'local-outbox', 'local-inbox'],
    ownership: ['shared', 'exclusive']
};
