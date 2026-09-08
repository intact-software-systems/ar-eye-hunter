import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type { ALInboundMessageRuntime } from './al-inbound-message-runtime.ts';

export interface ALInboundPendingAdmission {
    readonly kind: 'admit-message';
    readonly msg: ALMessage;
    readonly source: ALInboundMessageRuntime.Source;
}

export function toALInboundPendingAdmissionId(msg: ALMessage): string {
    return JSON.stringify(['admit-message', msg.id.senderId, msg.id.msgId]);
}
