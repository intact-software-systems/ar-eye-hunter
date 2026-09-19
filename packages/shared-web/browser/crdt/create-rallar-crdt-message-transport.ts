import type {
    RallarCrdtMessageTransport,
    RallarCrdtTransportMessage,
    RallarCrdtTransportSendInput
} from '@shared-web/browser/crdt/browser-crdt-transport.ts';
import { BrowserRallarMessageSender } from '@shared-web/browser/messages/browser-rallar-message-sender.ts';
import type { RallarMessagesOperations } from '@shared-web/browser/messages/rallar-message-operations.ts';
import { AL_DELIVERY_ADMITTED_STATES, isALDeliveryAdmitted } from '@shared/alm/delivery/al-delivery-lifecycle.ts';

export function createRallarCrdtMessageTransport(
    messages: RallarMessagesOperations
): RallarCrdtMessageTransport {
    return {
        ws: {
            send: async <T>(input: RallarCrdtTransportSendInput<T>) => {
                const result = await messages.ws.send<T>(input);
                const outcome = await result.wait({
                    until: AL_DELIVERY_ADMITTED_STATES,
                    timeoutMs: BrowserRallarMessageSender.DEFAULT_MESSAGE_TTL_MS
                });
                return {
                    transport: 'ws',
                    status: isALDeliveryAdmitted(outcome.lifecycle) ? 'sent' : 'failed',
                    reason: outcome.lifecycle.evidence.reason
                };
            },
            onMessage: <T>(
                selector: { readonly topicId?: string; readonly typeId?: string; },
                handler: (message: RallarCrdtTransportMessage<T>) => void | Promise<void>
            ) => messages.ws.onMessage<T>(selector, async (message) => {
                await handler({
                    payload: message.payload,
                    topicId: message.topicId,
                    typeId: message.typeId,
                    transport: 'ws'
                });
            })
        },
        rtc: {
            send: async <T>(input: RallarCrdtTransportSendInput<T>) => {
                const result = await messages.rtc.send<T>(input);
                const outcome = await result.wait({
                    until: AL_DELIVERY_ADMITTED_STATES,
                    timeoutMs: BrowserRallarMessageSender.DEFAULT_MESSAGE_TTL_MS
                });
                return {
                    transport: 'rtc',
                    status: isALDeliveryAdmitted(outcome.lifecycle) ? 'sent' : 'failed',
                    reason: outcome.lifecycle.evidence.reason
                };
            },
            onMessage: <T>(
                selector: { readonly topicId?: string; readonly typeId?: string; },
                handler: (message: RallarCrdtTransportMessage<T>) => void | Promise<void>
            ) => messages.rtc.onMessage<T>(selector, async (message) => {
                await handler({
                    payload: message.payload,
                    topicId: message.topicId,
                    typeId: message.typeId,
                    transport: 'rtc'
                });
            })
        }
    };
}
