import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    ConnectionContext,
    InMemoryQueueBox,
    JsonWebSocketServer,
    newALRoute,
    newALUntargetedMessage
} from '@shared/mod.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

describe('WS server inbound identity', () => {
    it('rejects a forged sender and preserves an exact matching non-CRDT message', async () => {
        const server = new JsonWebSocketServer();
        const socket = new FakeSocket();
        server.addConnection(new ConnectionContext('session-attacker', socket));
        const service = createDefaultWsQueueBoxServerService({
            inbox: new InMemoryQueueBox(),
            outbox: new InMemoryQueueBox(),
            socket: server,
            name: 'server-1'
        });
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

    it('rejects malformed current envelopes before admission policy runs', async () => {
        const server = new JsonWebSocketServer();
        const socket = new FakeSocket();
        server.addConnection(new ConnectionContext('session-1', socket));
        const admittedMessages: ALMessage[] = [];
        createDefaultWsQueueBoxServerService({
            inbox: new InMemoryQueueBox(),
            outbox: new InMemoryQueueBox(),
            socket: server,
            name: 'server-1',
            admitInboundMessage: (message) => {
                admittedMessages.push(message);
                return true;
            }
        });
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            await socket.dispatchValue({
                id: {
                    v: 2,
                    msgId: 'malformed-message',
                    ts: 1,
                    senderId: 'session-1'
                },
                payload: {
                    typeId: 'test.identity.v1',
                    resource: '{}'
                }
            });

            expect(admittedMessages).toEqual([]);
        }
        finally {
            consoleError.mockRestore();
        }
    });
});

class FakeSocket implements WebSocket {
    readonly CONNECTING = WebSocket.CONNECTING;
    readonly OPEN = WebSocket.OPEN;
    readonly CLOSING = WebSocket.CLOSING;
    readonly CLOSED = WebSocket.CLOSED;
    binaryType: BinaryType = 'blob';
    readonly bufferedAmount = 0;
    readonly extensions = '';
    onclose: ((this: WebSocket, event: CloseEvent) => void) | null = null;
    onerror: ((this: WebSocket, event: Event) => void) | null = null;
    onmessage: ((this: WebSocket, event: MessageEvent) => void) | null = null;
    onopen: ((this: WebSocket, event: Event) => void) | null = null;
    readonly protocol = '';
    readyState: WebSocket['readyState'] = WebSocket.OPEN;
    readonly url = 'ws://test.invalid';
    private readonly listeners = new Map<string, EventListenerOrEventListenerObject[]>();

    addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null
    ): void {
        if (!listener) {
            return;
        }
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null
    ): void {
        if (!listener) {
            return;
        }
        const listeners = this.listeners.get(type) ?? [];
        this.listeners.set(type, listeners.filter((candidate) => candidate !== listener));
    }

    dispatchEvent(event: Event): boolean {
        void this.dispatchListeners(event.type, event);
        return true;
    }

    close(): void {
        this.readyState = WebSocket.CLOSED;
    }

    send(_data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    }

    async dispatchMessage(message: ALMessage): Promise<void> {
        await this.dispatchValue(message);
    }

    async dispatchValue(value: object): Promise<void> {
        await this.dispatchListeners(
            'message',
            new MessageEvent('message', { data: JSON.stringify(value) })
        );
    }

    private async dispatchListeners(type: string, event: Event): Promise<void> {
        for (const listener of this.listeners.get(type) ?? []) {
            if (typeof listener === 'function') {
                await listener.call(this, event);
            }
            else {
                await listener.handleEvent(event);
            }
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
