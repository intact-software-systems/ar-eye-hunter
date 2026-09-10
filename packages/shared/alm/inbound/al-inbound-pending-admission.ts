import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type { ALDeadlinedMessage } from './al-inbound-message-deadline.ts';
import type { ALInboundMessageRuntime } from './al-inbound-message-runtime.ts';

export interface ALInboundPendingAdmission {
    readonly kind: 'admit-message';
    /** Retained with the deadline its queue row was written for; the decoder rejects a row without one. */
    readonly msg: ALDeadlinedMessage;
    readonly source: ALInboundMessageRuntime.Source;
}

export function toALInboundPendingAdmissionId(msg: ALMessage): string {
    return toPendingId('admit-message', msg);
}

export function toALInboundPendingControlId(msg: ALMessage): string {
    return toPendingId('admit-control', msg);
}

function toPendingId(kind: 'admit-message' | 'admit-control', msg: ALMessage): string {
    return [kind, msg.id.senderId, msg.id.msgId].map((part) => encodeURIComponent(part)).join(':');
}
