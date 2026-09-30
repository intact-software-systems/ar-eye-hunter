import { readALTargetGroupRef, type ALMessage } from '../../al-contracts/al-contract.ts';
import {
    decodeALAdmissionRecord,
    decodeALAdmissionString
} from '../../alm/al-admission-value-validation.ts';
import { decodeALOutboundRecipientScope } from '../../alm/outbound/admission/al-outbound-admission-validation.ts';
import {
    decodeALSessionInvalidationAuthority,
    validateALSessionInvalidationMessage
} from '../../alm/outbound/admission/al-session-invalidation-authority.ts';
import { decodeALOutboundTransportMessage } from '../../alm/outbound/al-outbound-transport-message.ts';
import type { Key } from '../../queuebox/ResourceEntry.ts';
import {
    isWsQueueBoxServerDirectScopedBroadcastRow,
    isWsQueueBoxServerDirectWorldBroadcastRow,
    readWsQueueBoxServerScopedTargetScope,
    requiresWsQueueBoxServerRecipientScope
} from './scope/requires-ws-queue-box-server-recipient-scope.ts';
import type { WsQueueBoxServerPreparedMessage } from './ws-queue-box-server-outbound-planning.ts';

export function decodeWsQueueBoxServerPreparedMessage(
    value: unknown,
    msg: ALMessage,
    referenceKey?: Key
): WsQueueBoxServerPreparedMessage {
    const prepared = decodeALAdmissionRecord(value, ['kind', 'message'], [
        'peerId',
        'connectionId',
        'generationId',
        'recipientScope',
        'principalTargetId',
        'sessionInvalidation'
    ]);
    if (prepared.kind === 'invalidated-session') {
        return decodeInvalidatedSessionPrepared(value, msg);
    }
    if (prepared.kind === 'scoped-recipient') {
        return decodeScopedRecipientPrepared(value, msg, referenceKey);
    }
    if (prepared.kind === 'room-recipient') {
        return decodeRoomRecipientPrepared(value, msg, referenceKey);
    }
    const message = decodeALOutboundTransportMessage(prepared.message, msg);
    if (prepared.kind === 'recipient') {
        if (isConnectionCheckedRow(msg, referenceKey)) {
            throw new TypeError('Persisted public WS unicast recipient has no scope proof');
        }
        decodeALAdmissionRecord(value, ['kind', 'message', 'peerId', 'connectionId']);
        return {
            kind: 'recipient',
            peerId: decodeALAdmissionString(prepared.peerId),
            connectionId: decodeALAdmissionString(prepared.connectionId),
            message
        };
    }
    if (prepared.kind === 'cluster-local-complete' || prepared.kind === 'cluster-receipt') {
        decodeALAdmissionRecord(value, ['kind', 'message']);
        return { kind: prepared.kind, message };
    }
    throw new TypeError('Persisted WS outbound prepared message kind is invalid');
}

function isConnectionCheckedRow(message: ALMessage, referenceKey: Key | undefined): boolean {
    return requiresWsQueueBoxServerRecipientScope(message) ||
        (message.targets?.mode === 'unicast' && message.targets.groupRef !== undefined) ||
        isWsQueueBoxServerDirectScopedBroadcastRow(message, referenceKey) ||
        isWsQueueBoxServerDirectWorldBroadcastRow(message, referenceKey);
}

function decodeRoomRecipientPrepared(
    value: unknown,
    message: ALMessage,
    referenceKey: Key | undefined
): WsQueueBoxServerPreparedMessage {
    const prepared = decodeALAdmissionRecord(value, [
        'kind',
        'message',
        'peerId',
        'connectionId',
        'generationId'
    ]);
    const peerId = decodeALAdmissionString(prepared.peerId);
    const connectionId = decodeALAdmissionString(prepared.connectionId);
    const targets = message.targets;
    const addressed = targets?.mode === 'unicast'
        ? targets.groupRef !== undefined && peerId === targets.toPeerId
        : readALTargetGroupRef(message) !== undefined &&
            isWsQueueBoxServerDirectScopedBroadcastRow(message, referenceKey) &&
            peerId === connectionId;
    if (!addressed) {
        throw new TypeError('Persisted room recipient differs from its group-addressed target');
    }
    return {
        kind: 'room-recipient',
        peerId,
        connectionId,
        generationId: decodeALAdmissionString(prepared.generationId),
        message: decodeALOutboundTransportMessage(prepared.message, message)
    };
}

function decodeScopedRecipientPrepared(
    value: unknown,
    message: ALMessage,
    referenceKey: Key | undefined
): WsQueueBoxServerPreparedMessage {
    const prepared = decodeALAdmissionRecord(value, [
        'kind',
        'message',
        'peerId',
        'connectionId',
        'generationId',
        'recipientScope'
    ], ['principalTargetId']);
    if (readALTargetGroupRef(message) !== undefined) {
        throw new TypeError(
            'Persisted scoped recipient stores a second scope for a group-addressed row'
        );
    }
    const scope = decodeALOutboundRecipientScope(prepared.recipientScope);
    const principalTargetId = prepared.principalTargetId === undefined
        ? undefined
        : decodeALAdmissionString(prepared.principalTargetId);
    if (isWsQueueBoxServerDirectScopedBroadcastRow(message, referenceKey)) {
        const targetScope = readWsQueueBoxServerScopedTargetScope(message);
        if (
            !targetScope || scope.applicationId !== targetScope.applicationId ||
            scope.workspaceId !== targetScope.workspaceId ||
            prepared.peerId !== prepared.connectionId ||
            principalTargetId !== undefined
        ) {
            throw new TypeError('Persisted scoped recipient differs from direct broadcast target');
        }
    }
    else if (isWsQueueBoxServerDirectWorldBroadcastRow(message, referenceKey)) {
        if (
            message.route.contextId !== scope.applicationId ||
            prepared.peerId !== prepared.connectionId ||
            principalTargetId !== undefined
        ) {
            throw new TypeError('Persisted scoped recipient differs from direct world target');
        }
    }
    else if (principalTargetId !== undefined) {
        if (
            referenceKey === undefined || referenceKey.topicId === 'AL_OUTBOUND_MESSAGE' ||
            message.targets?.mode !== 'unicast' || message.targets.toPeerId !== principalTargetId ||
            message.route.contextId !== principalTargetId ||
            prepared.peerId !== prepared.connectionId
        ) {
            throw new TypeError('Persisted scoped recipient differs from direct principal target');
        }
    }
    else if (message.targets?.mode !== 'unicast' || prepared.peerId !== message.targets.toPeerId) {
        throw new TypeError('Persisted scoped recipient differs from unicast target');
    }
    return {
        kind: 'scoped-recipient',
        peerId: decodeALAdmissionString(prepared.peerId),
        connectionId: decodeALAdmissionString(prepared.connectionId),
        generationId: decodeALAdmissionString(prepared.generationId),
        recipientScope: scope,
        ...(principalTargetId === undefined ? {} : { principalTargetId }),
        message: decodeALOutboundTransportMessage(prepared.message, message)
    };
}

function decodeInvalidatedSessionPrepared(value: unknown, message: ALMessage): WsQueueBoxServerPreparedMessage {
    const prepared = decodeALAdmissionRecord(value, [
        'kind',
        'message',
        'peerId',
        'connectionId',
        'generationId',
        'sessionInvalidation'
    ]);
    const sessionInvalidation = decodeALSessionInvalidationAuthority(prepared.sessionInvalidation);
    if (
        validateALSessionInvalidationMessage(message, sessionInvalidation).length > 0 ||
        prepared.peerId !== sessionInvalidation.sessionId || prepared.connectionId !== sessionInvalidation.sessionId
    ) {
        throw new TypeError('Prepared invalidation differs from exact session');
    }
    return {
        kind: 'invalidated-session',
        peerId: sessionInvalidation.sessionId,
        connectionId: sessionInvalidation.sessionId,
        generationId: decodeALAdmissionString(prepared.generationId),
        sessionInvalidation,
        message: decodeALOutboundTransportMessage(prepared.message, message)
    };
}
