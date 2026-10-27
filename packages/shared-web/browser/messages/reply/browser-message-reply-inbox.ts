import type { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { BrowserMessageReplySlots } from '@shared-web/browser/messages/reply/browser-message-reply-slots.ts';
import { toRallarMessage, type RallarMessageReplySender } from '@shared-web/browser/messages/to-rallar-message.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { BrowserWebSocketInbox } from '@shared-web/browser/websocket/browser-websocket-inbox.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toALCorrId } from '@shared/al-contracts/reply/to-al-reply-actions.ts';
import {
    recordALInboundDiagnostic,
    type ALInboundRuntimeDiagnosticsEvent,
    type ALInboundRuntimeDiagnosticsSink
} from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';

export namespace BrowserMessageReplyInbox {
    export interface Input {
        readonly wsInbox: BrowserWebSocketInbox;
        readonly deliveries: BrowserRallarDeliveryRegistry;
        readonly sendReply: RallarMessageReplySender;
        readInboundDiagnostics(): ALInboundRuntimeDiagnosticsSink;
    }
}

/**
 * Replies travel over WS only: the RTC inbox holds one callback per type, which the messaging subscriptions own.
 * Every reply reaches the delivery registry here, and none reaches an `onMessage` subscriber of its type.
 */
export class BrowserMessageReplyInbox {
    private readonly input: BrowserMessageReplyInbox.Input;

    constructor(input: BrowserMessageReplyInbox.Input) {
        this.input = input;
    }

    /** Subscribes the WS inbox as `message-replies` at order 15. */
    start(): RallarUnsubscribe {
        return this.input.wsInbox.subscribe({
            id: 'message-replies',
            order: 15,
            onMessage: (message) => this.receive(message)
        });
    }

    private receive(message: ALMessage): void {
        const replyToMsgId = message.actions?.replyToMsgId;
        if (replyToMsgId === undefined) {
            return;
        }
        const admission = this.input.deliveries.recordReply(
            toRallarMessage<RallarMessagePayload>('ws', message, this.input.sendReply)
        );
        if (admission.kind !== 'matched') {
            recordALInboundDiagnostic(
                this.input.readInboundDiagnostics(),
                toReplyDropDiagnostic({ message, replyToMsgId, admission })
            );
        }
    }
}

interface ReplyDrop {
    readonly message: ALMessage;
    readonly replyToMsgId: string;
    readonly admission: Exclude<BrowserMessageReplySlots.Admission, Readonly<{ kind: 'matched'; }>>;
}

/** Payload-free: a dropped reply states its identity and why it was dropped, never what it carried. */
function toReplyDropDiagnostic({ message, replyToMsgId, admission }: ReplyDrop): ALInboundRuntimeDiagnosticsEvent {
    const identity = {
        msgId: message.id.msgId,
        replyToMsgId,
        corrId: toALCorrId(message),
        typeId: message.payload.typeId,
        senderId: message.id.senderId,
        carrier: 'ws'
    } as const;
    return admission.kind === 'late'
        ? { kind: 'reply-late', ...identity, cause: admission.cause }
        : { kind: 'reply-wrong-responder', ...identity, expectedSenderId: admission.expectedSenderId };
}
