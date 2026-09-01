import { configureBrowserALRuntimeStores } from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { toResilienceDto } from '@shared-web/browser/resilience-config.ts';
import { createBrowserWebSocketQueueBox } from '@shared-web/browser/websocket/create-browser-web-socket-queue-box.ts';
import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import type { ClientInfo } from '@shared/api/api-config.ts';
import { CommandTimedOutError } from '@shared/cache/Command.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { JsonWebSocketClient } from '@shared/websocket/JsonWebSocketClient.ts';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { TestWebSocket } from '../../shared/websocket/test-web-socket.ts';

const clientData: ClientInfo = {
    clientId: 'client-1',
    sessionId: 'session-1',
    isOnline: true
};

describe('createBrowserWebSocketQueueBox', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', TestWebSocket);
        onTestFinished(() => {
            vi.clearAllTimers();
            vi.useRealTimers();
            vi.unstubAllGlobals();
            TestWebSocket.instances.length = 0;
        });
        configureBrowserALRuntimeStores(clientData.sessionId);
    });

    it('returns an open service for the session after the initial socket opens', async () => {
        const socket = new JsonWebSocketClient('ws://test');
        onTestFinished(() => socket.close(1000, 'test-finished'));
        const qboxEngine = new InboxOutboxEngine();
        onTestFinished(() => qboxEngine.stop());
        const controller = new AbortController();
        onTestFinished(() => controller.abort());

        const initialized = createBrowserWebSocketQueueBox({
            qboxEngine,
            socket,
            clientData,
            resilience: toResilienceDto(),
            connectTimeoutMs: 25,
            signal: controller.signal
        });
        onTestFinished(async () => {
            controller.abort();
            await initialized.catch(() => undefined);
        });
        await vi.advanceTimersByTimeAsync(0);
        const native = readCreatedSocket();
        expect(native.readyState).toBe(WebSocket.CONNECTING);

        native.open();
        const service = await initialized;
        onTestFinished(() => service.close(1000, 'test-finished'));

        expect(service.sessionId).toBe('session-1');
        expect(service.readHealth()).toMatchObject({
            sessionId: 'session-1',
            url: 'ws://test',
            isOpen: true,
            readyState: 'open',
            reconnectEnabled: true
        });
        expect(TestWebSocket.instances).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(25);
        expect(service.readHealth().isOpen).toBe(true);
        expect(native.closedWith).toBeUndefined();
    });

    it.each([
        { label: 'configured', connectTimeoutMs: 25, deadlineMs: 25 },
        { label: 'default', connectTimeoutMs: undefined, deadlineMs: 10_000 }
    ])('aborts a pending real socket at the $label connect timeout', async ({ connectTimeoutMs, deadlineMs }) => {
        const socket = new JsonWebSocketClient('ws://test');
        onTestFinished(() => socket.close(1000, 'test-finished'));
        const qboxEngine = new InboxOutboxEngine();
        onTestFinished(() => qboxEngine.stop());
        const controller = new AbortController();
        onTestFinished(() => controller.abort());

        const initialized = createBrowserWebSocketQueueBox({
            qboxEngine,
            socket,
            clientData,
            resilience: toResilienceDto(),
            connectTimeoutMs,
            signal: controller.signal
        });
        onTestFinished(async () => {
            controller.abort();
            await initialized.catch(() => undefined);
        });
        const rejected = expect(initialized).rejects.toBeInstanceOf(CommandTimedOutError);
        await vi.advanceTimersByTimeAsync(deadlineMs - 1);
        const native = readCreatedSocket();
        expect(native.readyState).toBe(WebSocket.CONNECTING);
        expect(native.closedWith).toBeUndefined();

        await vi.advanceTimersByTimeAsync(1);
        await rejected;

        expect(native.readyState).toBe(WebSocket.CLOSED);
        expect(native.closedWith).toEqual({ code: 1000, reason: 'connect-aborted' });
        expect(socket.ws).toBeUndefined();
    });

    it('ignores incoming data before connect and delivers it after the service is ready', async () => {
        const socket = new JsonWebSocketClient('ws://test');
        onTestFinished(() => socket.close(1000, 'test-finished'));
        const qboxEngine = new InboxOutboxEngine();
        onTestFinished(() => qboxEngine.stop());
        const controller = new AbortController();
        onTestFinished(() => controller.abort());
        const initialized = createBrowserWebSocketQueueBox({
            qboxEngine,
            socket,
            clientData,
            resilience: toResilienceDto(),
            connectTimeoutMs: 0,
            signal: controller.signal
        });
        onTestFinished(async () => {
            controller.abort();
            await initialized.catch(() => undefined);
        });
        await vi.advanceTimersByTimeAsync(0);
        const native = readCreatedSocket();
        const msg = newALUnicastMessage(
            'server',
            { topicId: 'chat', resourceId: 'early-delivery', contextId: 'conversation' },
            'session-1',
            'chat.message.v1',
            { text: 'hello' }
        );

        native.receive(JSON.stringify(msg));
        await vi.advanceTimersByTimeAsync(0);
        native.open();
        const service = await initialized;
        onTestFinished(() => service.close(1000, 'test-finished'));
        const received: string[] = [];
        service.onInboxMessageDo('chat.message.v1', {
            onMessage: async (message) => {
                received.push(message.id.msgId);
            }
        });

        // Reusing the same message also catches premature admission that consumed its dedup identity.
        native.receive(JSON.stringify(msg));
        await vi.waitFor(() => expect(received).toEqual([msg.id.msgId]));
        expect(service.readHealth().isOpen).toBe(true);
    });

    it.each([0, -1])('allows a pending connection with connectTimeoutMs=%i until its socket opens', async (connectTimeoutMs) => {
        const socket = new JsonWebSocketClient('ws://test');
        onTestFinished(() => socket.close(1000, 'test-finished'));
        const qboxEngine = new InboxOutboxEngine();
        onTestFinished(() => qboxEngine.stop());
        const controller = new AbortController();
        onTestFinished(() => controller.abort());
        const initialized = createBrowserWebSocketQueueBox({
            qboxEngine,
            socket,
            clientData,
            resilience: toResilienceDto(),
            connectTimeoutMs,
            signal: controller.signal
        });
        onTestFinished(async () => {
            controller.abort();
            await initialized.catch(() => undefined);
        });
        await vi.advanceTimersByTimeAsync(20_000);
        const native = readCreatedSocket();
        expect(native.readyState).toBe(WebSocket.CONNECTING);
        expect(native.closedWith).toBeUndefined();

        native.open();
        const service = await initialized;
        onTestFinished(() => service.close(1000, 'test-finished'));

        expect(service.sessionId).toBe('session-1');
        expect(service.readHealth()).toMatchObject({ isOpen: true, reconnectEnabled: true });
    });
});

function readCreatedSocket(): TestWebSocket {
    const socket = TestWebSocket.instances.at(-1);
    if (!socket) {
        throw new Error('Connecting the client must create a WebSocket');
    }
    return socket;
}
