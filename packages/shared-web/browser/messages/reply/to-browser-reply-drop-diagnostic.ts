import type { BrowserMessageReplySlot } from '@shared-web/browser/messages/reply/browser-message-reply-slot.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toALMessageTrace } from '@shared/al-contracts/trace/to-al-message-trace.ts';
import type { ALDeliveryCarrier } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';

export interface BrowserReplyDrop {
    readonly message: ALMessage;
    readonly replyToMsgId: string;
    readonly carrier: ALDeliveryCarrier;
    readonly admission: Exclude<BrowserMessageReplySlot.Admission, Readonly<{ kind: 'matched'; }>>;
}

/** Payload-free: a dropped reply states its identity and why it was dropped, never what it carried. */
export function toBrowserReplyDropDiagnostic(drop: BrowserReplyDrop): ALInboundRuntimeDiagnosticsEvent {
    const { message, admission } = drop;
    const identity = {
        msgId: message.id.msgId,
        replyToMsgId: drop.replyToMsgId,
        typeId: message.payload.typeId,
        senderId: message.id.senderId,
        carrier: drop.carrier
    };
    const trace = toALMessageTrace(message);
    return admission.kind === 'late'
        ? { kind: 'reply-late', ...identity, cause: admission.cause, ...trace }
        : { kind: 'reply-wrong-responder', ...identity, expectedSenderId: admission.expectedSenderId, ...trace };
}
