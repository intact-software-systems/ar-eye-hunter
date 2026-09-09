import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type { ALInboundMessageRuntime } from './al-inbound-message-runtime.ts';

export interface ALInboundPendingAdmission {
    readonly kind: 'admit-message';
    readonly msg: ALMessage;
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
