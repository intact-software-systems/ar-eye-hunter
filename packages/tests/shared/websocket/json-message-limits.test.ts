import { afterEach, describe, expect, it, vi } from 'vitest';

import { AL_MESSAGE_RESOURCE_LIMITS } from '@shared/al-contracts/al-message-resource-limits.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { TestWebSocket } from './test-web-socket.ts';

describe('JSON websocket subscription wire limits', () => {
    it('preserves parse-error observers when no decoded-message subscription is installed', () => {
        vi.stubGlobal('WebSocket', TestWebSocket);
        const server = new JsonWebSocketServer();
        const socket = new TestWebSocket('server');
        server.addConnection(new ConnectionContext({ id: 'self', socket }));
        const errors: string[] = [];
        server.onWebsocketCallbacksDo('parse-errors', {
            onParseError: (_context, raw) => {
                errors.push(raw);
            }
        });
        socket.receive('not-json');
        expect(errors).toEqual(['not-json']);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        TestWebSocket.instances.length = 0;
    });

    it('rejects oversized client frames before parsing and keeps accepting bounded traffic', async () => {
        vi.stubGlobal('WebSocket', TestWebSocket);
        const client = new JsonWebSocketClient('ws://test');
        const rejected: string[] = [];
        const delivered: unknown[] = [];
        client.onWebSocketMessageDo('alm', {
            maxMessageBytes: AL_MESSAGE_RESOURCE_LIMITS.envelopeBytes,
            onRejected: async (reason) => {
                rejected.push(reason.code);
            },
            onMessage: async (value) => {
                delivered.push(value);
            }
        });
        const connecting = client.connect();
        await Promise.resolve();
        const socket = TestWebSocket.instances[0];
        socket.open();
        await connecting;
        const parse = vi.spyOn(JSON, 'parse');

        socket.receive(' '.repeat(AL_MESSAGE_RESOURCE_LIMITS.envelopeBytes + 1));
        expect(parse).not.toHaveBeenCalled();
        expect(rejected).toEqual(['oversized']);
        expect(delivered).toEqual([]);
        socket.receive('{}');
        await vi.waitFor(() => expect(delivered).toEqual([{}]));
        client.close();
    });

    it('limits server ALM subscriptions without limiting generic JSON subscribers', async () => {
        vi.stubGlobal('WebSocket', TestWebSocket);
        const server = new JsonWebSocketServer();
        const socket = new TestWebSocket('server');
        server.addConnection(new ConnectionContext({ id: 'self', socket }));
        const rejected: string[] = [];
        const delivered: unknown[] = [];
        server.onMessageDo('alm', {
            maxMessageBytes: 4,
            onRejected: async (_context, reason) => {
                rejected.push(reason.code);
            },
            onMessage: async (_context, value) => {
                delivered.push(value);
            }
        });
        const parse = vi.spyOn(JSON, 'parse');
        socket.receive('"éé"');
        expect(parse).not.toHaveBeenCalled();
        expect(rejected).toEqual(['oversized']);
        expect(delivered).toEqual([]);

        await Promise.resolve();
        const generic: unknown[] = [];
        server.onMessageDo('generic', {
            onMessage: async (_context, value) => {
                generic.push(value);
            }
        });
        socket.receive('"éé"');
        await vi.waitFor(() => expect(generic).toEqual(['éé']));
        socket.receive('"é"');
        await vi.waitFor(() => expect(delivered).toEqual(['é']));
    });

    it('checks native binary sizes without Blob conversion or JSON coercion', async () => {
        vi.stubGlobal('WebSocket', TestWebSocket);
        const server = new JsonWebSocketServer();
        const socket = new TestWebSocket('server');
        server.addConnection(new ConnectionContext({ id: 'self', socket }));
        const rejected: string[] = [];
        const delivered: unknown[] = [];
        server.onMessageDo('alm', {
            maxMessageBytes: 4,
            onRejected: async (_context, reason) => {
                rejected.push(reason.code);
            },
            onMessage: async (_context, value) => {
                delivered.push(value);
            }
        });
        const blob = new Blob(['oversized']);
        const text = vi.spyOn(blob, 'text');
        const parse = vi.spyOn(JSON, 'parse');
        for (const data of [blob, new ArrayBuffer(5), new Uint8Array(5)]) {
            socket.dispatchEvent(new MessageEvent('message', { data }));
        }
        expect(rejected).toEqual(['oversized', 'oversized', 'oversized']);
        expect(delivered).toEqual([]);
        expect(text).not.toHaveBeenCalled();
        expect(parse).not.toHaveBeenCalled();
    });
});
