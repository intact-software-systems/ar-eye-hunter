import { describe, expect, it, vi } from 'vitest';

import { initRallarSystemWsTopics, type InitRallarSystemWsTopicsOptions } from '@shared-server/rallar-system/websocket/ws-system-topics.ts';
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
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

interface DurableRtcRttOptions extends InitRallarSystemWsTopicsOptions {
    readonly enqueueRtcRttMutation: (
        input: Readonly<{
            rtt: RttMeasurement;
            alSenderId: string;
            capturedAtEpochMs: number;
        }>
    ) => Promise<ResourceEntry>;
}

interface RttMeasurement {
    readonly sessionIdFrom: string;
    readonly sessionIdTo: string;
    readonly rttMs: number;
    readonly createdAtEpochMs: number;
    readonly version: number;
}

describe('Rallar system WS AppInbox routing', () => {
    it('acknowledges persisted RTT ingress after durable enqueue without result effects', async () => {
        const server = new JsonWebSocketServer();
        const socket = new FakeSocket();
        server.addConnection(new ConnectionContext('session-a', socket as never));
        const service = new WsQueueBoxServerService(
            new InMemoryQueueBox(new Map()),
            new InMemoryQueueBox(new Map()),
            server,
            'server-1'
        );
        const durableRow = { key: { resourceId: 'rtt-1' } } as ResourceEntry;
        const enqueueRtcRttMutation = vi.fn(() => Promise.resolve(durableRow));
        const options: DurableRtcRttOptions = {
            enqueueRtcRttMutation
        };
        initRallarSystemWsTopics(service, options);
        const rtt: RttMeasurement = {
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
});

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
