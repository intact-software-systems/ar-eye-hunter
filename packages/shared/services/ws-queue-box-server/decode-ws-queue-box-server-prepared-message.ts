import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { decodeALAdmissionRecord, decodeALAdmissionString } from '../../alm/al-admission-value-validation.ts';
import { decodeALOutboundTransportMessage } from '../../alm/outbound/al-outbound-transport-message.ts';
import type { WsQueueBoxServerPreparedMessage } from './ws-queue-box-server-outbound-planning.ts';

export function decodeWsQueueBoxServerPreparedMessage(value: unknown, msg: ALMessage): WsQueueBoxServerPreparedMessage {
    const prepared = decodeALAdmissionRecord(value, ['kind', 'message'], ['peerId', 'connectionId']);
    const message = decodeALOutboundTransportMessage(prepared.message, msg);
    if (prepared.kind === 'recipient') {
        decodeALAdmissionRecord(value, ['kind', 'message', 'peerId', 'connectionId']);
        return {
            kind: 'recipient',
            peerId: decodeALAdmissionString(prepared.peerId),
            connectionId: decodeALAdmissionString(prepared.connectionId),
            message
        };
    }
    if (prepared.kind === 'cluster-local-complete') {
        decodeALAdmissionRecord(value, ['kind', 'message']);
        return { kind: 'cluster-local-complete', message };
    }
    throw new TypeError('Persisted WS outbound prepared message kind is invalid');
}
