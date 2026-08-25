import { describe, expect, it, vi } from 'vitest';

import { installRtcRttSystemTopic, type InstallRtcRttSystemTopicOptions } from '@shared-server/rallar-system/rtc-rtt/topic/install-rtc-rtt-system-topic.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import {
    AppTopics,
    ConnectionContext,
    InMemoryQueueBox,
    JsonWebSocketServer,
    newALBroadcastMessage,
    newALEventRoute,
    WsQueueBoxServerService,
    type ALMessage
} from '@shared/mod.ts';
import { toResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

describe('RTC RTT websocket AppInbox routing', () => {
    it('acknowledges persisted RTT ingress after durable enqueue without result effects', async () => {
        const enqueueRtcRttMutation = vi.fn(() => Promise.resolve(toResourceEntry('APP_INBOX', { commandId: 'rtt-1' })));
        const socket = createHarness({
            enqueueMutation: enqueueRtcRttMutation
        });
        const rtt: RttMeasurementInfo = {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 12,
            createdAtEpochMs: 1,
            version: 1
        };

        await socket.dispatchMessage(newALBroadcastMessage(
            'session-a',
            newALEventRoute(AppTopics.rtt, 'room-1', 'rtt-1'),
            'room',
            AppTopics.rtt,
            rtt
        ));

        expect(enqueueRtcRttMutation).toHaveBeenCalledWith({
            rtt,
            alSenderId: 'session-a',
            capturedAtEpochMs: expect.any(Number)
        });
    });

    it('rejects malformed current RTT payloads before durable enqueue', async () => {
        const enqueueMutation = vi.fn(() => Promise.resolve(toResourceEntry('APP_INBOX', { commandId: 'rtt-1' })));
        const socket = createHarness({ enqueueMutation });
        const reportFailure = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await socket.dispatchMessage(newALBroadcastMessage(
            'session-a',
            newALEventRoute(AppTopics.rtt, 'room-1', 'rtt-1'),
            'room',
            AppTopics.rtt,
            {
                sessionIdFrom: 'session-a',
                sessionIdTo: 'session-b',
                rttMs: 12,
                createdAtEpochMs: 1,
                version: 1,
                unexpected: true
            }
        ));
        expect(enqueueMutation).not.toHaveBeenCalled();
        expect(reportFailure).toHaveBeenCalledWith(
            'Error calling onMessage callback',
            expect.any(TypeError)
        );
        reportFailure.mockRestore();
    });
});

function createHarness(options: InstallRtcRttSystemTopicOptions): FakeSocket {
    const server = new JsonWebSocketServer();
    const socket = new FakeSocket();
    server.addConnection(new ConnectionContext('session-a', socket as never));
    installRtcRttSystemTopic(
        new WsQueueBoxServerService(
            new InMemoryQueueBox(new Map()),
            new InMemoryQueueBox(new Map()),
            server,
            'server-1'
        ),
        options
    );
    return socket;
}

class FakeSocket {
    readonly readyState = WebSocket.OPEN;
    private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();

    addEventListener(type: string, listener: (event: MessageEvent) => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    send(_data: string): void {}

    async dispatchMessage(message: ALMessage): Promise<void> {
        const event = { data: JSON.stringify(message) } as MessageEvent;
        for (const listener of this.listeners.get('message') ?? []) {
            await listener(event);
        }
    }
}
