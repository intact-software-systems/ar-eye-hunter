import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { decodeALAdmissionRecord, decodeALAdmissionString } from '../../alm/al-admission-value-validation.ts';
import { decodeALOutboundRecipientScope } from '../../alm/outbound/admission/al-outbound-admission-validation.ts';
import { decodeALOutboundTransportMessage } from '../../alm/outbound/al-outbound-transport-message.ts';
import type { Key } from '../../queuebox/ResourceEntry.ts';
import {
    isWsQueueBoxServerDirectScopedBroadcastRow,
    readWsQueueBoxServerScopedTargetScope,
    requiresWsQueueBoxServerRecipientScope
} from './requires-ws-queue-box-server-recipient-scope.ts';
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
        'recipientScope'
    ]);
    const message = decodeALOutboundTransportMessage(prepared.message, msg);
    if (prepared.kind === 'scoped-recipient') {
        decodeALAdmissionRecord(value, ['kind', 'message', 'peerId', 'connectionId', 'generationId', 'recipientScope']);
        if (isWsQueueBoxServerDirectScopedBroadcastRow(msg, referenceKey)) {
            const scope = decodeALOutboundRecipientScope(prepared.recipientScope);
            const targetScope = readWsQueueBoxServerScopedTargetScope(msg);
            if (
                !targetScope || scope.applicationId !== targetScope.applicationId ||
                scope.workspaceId !== targetScope.workspaceId ||
                prepared.peerId !== prepared.connectionId
            ) {
                throw new TypeError('Persisted scoped recipient differs from direct broadcast target');
            }
        }
        else if (msg.targets?.mode !== 'unicast' || prepared.peerId !== msg.targets.toPeerId) {
            throw new TypeError('Persisted scoped recipient differs from unicast target');
        }
        return {
            kind: 'scoped-recipient',
            peerId: decodeALAdmissionString(prepared.peerId),
            connectionId: decodeALAdmissionString(prepared.connectionId),
            generationId: decodeALAdmissionString(prepared.generationId),
            recipientScope: decodeALOutboundRecipientScope(prepared.recipientScope),
            message
        };
    }
    if (prepared.kind === 'recipient') {
        if (
            requiresWsQueueBoxServerRecipientScope(msg) ||
            isWsQueueBoxServerDirectScopedBroadcastRow(msg, referenceKey)
        ) {
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
