import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { installRtcRttSystemTopic, type InstallRtcRttSystemTopicOptions } from '@shared-server/rallar-system/rtc-rtt/topic/install-rtc-rtt-system-topic.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
    AppTopics,
    ConnectionContext,
    createDefaultWsQueueBoxServerService,
    InMemoryQueueBox,
    JsonWebSocketServer,
    newALBroadcastMessage,
    newALEventRoute,
    type ALMessage
} from '@shared/mod.ts';
import { toResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

type RtcRttMutationInput = Parameters<InstallRtcRttSystemTopicOptions['enqueueMutation']>[0];

const RTC_RTT_GROUP_REF: GroupRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'room-1'
};

describe('RTC RTT websocket AppInbox routing', () => {
    it('acknowledges persisted RTT ingress after durable enqueue without result effects', async () => {
        const enqueuedMutations: RtcRttMutationInput[] = [];
        const socket = createHarness({
            enqueueMutation: (input) => {
                enqueuedMutations.push(input);
                return Promise.resolve(toResourceEntry('APP_INBOX', { commandId: 'rtt-1' }));
            }
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
            rtt,
            { groupRef: RTC_RTT_GROUP_REF }
        ));

        expect(enqueuedMutations).toEqual([{
            rtt,
            alSenderId: 'session-a',
            capturedAtEpochMs: expect.any(Number)
        }]);
    });

    it('rejects malformed current RTT payloads before durable enqueue', async () => {
        const enqueuedMutations: RtcRttMutationInput[] = [];
        const socket = createHarness({
            enqueueMutation: (input) => {
                enqueuedMutations.push(input);
                return Promise.resolve(toResourceEntry('APP_INBOX', { commandId: 'rtt-1' }));
            }
        });
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
            },
            { groupRef: RTC_RTT_GROUP_REF }
        ));
        expect(enqueuedMutations).toEqual([]);
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
    server.addConnection(new ConnectionContext('session-a', socket));
    installRtcRttSystemTopic(
        createDefaultWsQueueBoxServerService({
            inbox: new InMemoryQueueBox(new Map()),
            outbox: new InMemoryQueueBox(new Map()),
            socket: server,
            name: 'server-1'
        }),
        options
    );
    return socket;
}

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
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null
    ): void {
        if (!listener) {
            return;
        }
        this.listeners.set(
            type,
            (this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener)
        );
    }

    dispatchEvent(event: Event): boolean {
        void this.dispatchListeners(event.type, event);
        return true;
    }

    close(): void {
        this.readyState = WebSocket.CLOSED;
    }

    send(_data: string | ArrayBufferLike | Blob | ArrayBufferView): void {}

    async dispatchMessage(message: ALMessage): Promise<void> {
        await this.dispatchListeners(
            'message',
            new MessageEvent('message', { data: JSON.stringify(message) })
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
