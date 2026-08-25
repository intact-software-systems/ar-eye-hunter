import type { RallarCrdtMessageTransport } from '@shared-web/browser/rallar-crdt-transport.ts';
import type { RallarMessagesOperations } from '@shared-web/browser/messages/rallar-message-operations.ts';

export function createRallarCrdtMessageTransport(
    messages: RallarMessagesOperations
): RallarCrdtMessageTransport {
    return {
        ws: {
            send: async (input) => {
                const result = await messages.ws.send(input as never);
                return {
                    transport: 'ws',
                    status: result.status,
                    reason: result.reason
                };
            },
            onMessage: (selector, handler) =>
                messages.ws.onMessage(selector, async (message) => {
                    await handler({
                        payload: message.payload as never,
                        topicId: message.topicId,
                        typeId: message.typeId,
                        transport: 'ws'
                    });
                })
        },
        rtc: {
            send: async (input) => {
                const result = await messages.rtc.send(input as never);
                return {
                    transport: 'rtc',
                    status: result.status,
                    reason: result.reason
                };
            },
            onMessage: (selector, handler) =>
                messages.rtc.onMessage(selector, async (message) => {
                    await handler({
                        payload: message.payload as never,
                        topicId: message.topicId,
                        typeId: message.typeId,
                        transport: 'rtc'
                    });
                })
        }
    };
}
