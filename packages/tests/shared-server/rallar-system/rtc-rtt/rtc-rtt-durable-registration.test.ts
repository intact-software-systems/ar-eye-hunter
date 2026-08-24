import type { RtcRttRuntimeState } from '@shared-server/rallar-system/rtc-rtt/rtc-rtt-runtime-state.ts';
import { installRtcRttSystemTopic, type InstallRtcRttSystemTopicOptions } from '@shared-server/rallar-system/rtc-rtt/topic/install-rtc-rtt-system-topic.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics, ConnectionContext, InMemoryQueueBox, JsonWebSocketServer, newALBroadcastMessage, newALEventRoute } from '@shared/mod.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import { describe, expect, it } from 'vitest';

const RTT = {
    sessionIdFrom: 'session-a',
    sessionIdTo: 'session-b',
    rttMs: 12,
    createdAtEpochMs: 1_000,
    version: 1
} as const;

describe('RTC RTT durable registration', () => {
    it('routes RTT through the registered AppInbox entry owner', async () => {
        const enqueuedMutations: Array<Parameters<NonNullable<InstallRtcRttSystemTopicOptions['enqueueMutation']>>[0]> = [];
        const socket = createHarness({
            enqueueMutation: async (mutation) => {
                enqueuedMutations.push(mutation);
                return {} as ResourceEntry;
            }
        });

        await socket.dispatchMessage(rttMessage());

        expect(enqueuedMutations).toEqual([
            {
                rtt: RTT,
                alSenderId: 'session-a',
                capturedAtEpochMs: expect.any(Number)
            }
        ]);
    });

    it('requires the AppInbox entry owner before registering persisted RTT state', () => {
        expect(() =>
            createHarness({
                runtimeState: {} as RtcRttRuntimeState
            })
        ).toThrow(/requires durable AppInbox enqueue/i);
    });
});

function createHarness(options: Omit<InstallRtcRttSystemTopicOptions, 'findGroupSnapshotByRef'>): FakeSocket {
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
        { ...options, findGroupSnapshotByRef: () => undefined }
    );
    return socket;
}

function rttMessage(): ALMessage {
    return newALBroadcastMessage(
        'session-a',
        newALEventRoute(AppTopics.rtt, 'room-1', 'rtt-options'),
        'room',
        AppTopics.rtt,
        RTT
    );
}

class FakeSocket {
    readonly readyState = WebSocket.OPEN;
    private readonly listeners = new Map<string, Array<(event: MessageEvent) => void | Promise<void>>>();

    addEventListener(
        type: string,
        listener: (event: MessageEvent) => void | Promise<void>
    ): void {
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
