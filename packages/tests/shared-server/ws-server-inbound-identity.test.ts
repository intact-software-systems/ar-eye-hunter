import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { ConnectionContext, InMemoryQueueBox, JsonWebSocketServer, newALRoute, newALUntargetedMessage } from '@shared/mod.ts';
import { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import { describe, expect, it, vi } from 'vitest';

describe('WS server inbound identity', () => {
    it('rejects a forged sender and preserves an exact matching non-CRDT message', async () => {
        const server = new JsonWebSocketServer();
        const socket = new FakeSocket();
        server.addConnection(new ConnectionContext('session-attacker', socket as never));
        const service = new WsQueueBoxServerService(
            new InMemoryQueueBox(),
            new InMemoryQueueBox(),
            server,
            'server-1'
        );
        const received: ALMessage[] = [];
        service.onAnyInboxMessageDo('identity-test', {
            onMessage: (message) => {
                received.push(message);
                return Promise.resolve();
            }
        });
        const forged = message('session-victim', 'forged-message');
        const matching = message('session-attacker', 'matching-message');
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            await socket.dispatchMessage(forged);
            expect(received).toEqual([]);

            await socket.dispatchMessage(matching);
            expect(received).toEqual([matching]);
        }
        finally {
            consoleError.mockRestore();
        }
    });
});

class FakeSocket {
    readonly readyState = WebSocket.OPEN;
    private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();

    addEventListener(type: string, listener: (event: MessageEvent) => void): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    send(_data: string): void {
    }

    async dispatchMessage(message: ALMessage): Promise<void> {
        const event = { data: JSON.stringify(message) } as MessageEvent;
        for (const listener of this.listeners.get('message') ?? []) {
            await listener(event);
        }
    }
}

function message(senderId: string, messageId: string): ALMessage {
    const value = newALUntargetedMessage(
        senderId,
        newALRoute('test.identity', 'context-1', messageId),
        'test.identity.v1',
        { value: messageId }
    );
    return { ...value, id: { ...value.id, msgId: messageId } };
}
