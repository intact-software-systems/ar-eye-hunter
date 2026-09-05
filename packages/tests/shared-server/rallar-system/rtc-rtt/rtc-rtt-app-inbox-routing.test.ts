import {
    describe,
    expect,
    it,
    onTestFinished
} from 'vitest';

import {
    installRtcRttSystemTopic,
    type InstallRtcRttSystemTopicOptions,
    type RtcRttTopicMutationInput
} from '@shared-server/rallar-system/rtc-rtt/topic/install-rtc-rtt-system-topic.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import {
    AppTopics,
    ConnectionContext,
    createDefaultWsQueueBoxServerService,
    InMemoryQueueBox,
    JsonWebSocketServer,
    newALEventRoute,
    newALUntargetedMessage
} from '@shared/mod.ts';
import { toResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { SimulatedWebSocket } from '../../../shared/native-websocket-fixture.ts';

describe('RTC RTT websocket AppInbox routing', () => {
    it('acknowledges persisted RTT ingress after durable enqueue without result effects', async () => {
        const enqueuedMutations: RtcRttTopicMutationInput[] = [];
        const socket = await createHarness({
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

        await socket.receive(JSON.stringify(newALUntargetedMessage(
            'session-a',
            newALEventRoute(AppTopics.rtt, 'room-1', 'rtt-1'),
            AppTopics.rtt,
            rtt
        )));

        expect(enqueuedMutations).toEqual([{
            rtt,
            alSenderId: 'session-a',
            capturedAtEpochMs: expect.any(Number)
        }]);
    });

    it('rejects malformed current RTT payloads before durable enqueue', async () => {
        const enqueuedMutations: RtcRttTopicMutationInput[] = [];
        const socket = await createHarness({
            enqueueMutation: (input) => {
                enqueuedMutations.push(input);
                return Promise.resolve(toResourceEntry('APP_INBOX', { commandId: 'rtt-1' }));
            }
        });

        await socket.receive(JSON.stringify(newALUntargetedMessage(
            'session-a',
            newALEventRoute(AppTopics.rtt, 'room-1', 'rtt-1'),
            AppTopics.rtt,
            {
                sessionIdFrom: 'session-a',
                sessionIdTo: 'session-b',
                rttMs: 12,
                createdAtEpochMs: 1,
                version: 1,
                unexpected: true
            }
        )));
        expect(enqueuedMutations).toEqual([]);
    });
});

async function createHarness(options: InstallRtcRttSystemTopicOptions): Promise<SimulatedWebSocket> {
    const server = new JsonWebSocketServer();
    const socket = new SimulatedWebSocket('ws://rtt-topic-test');
    await socket.open();
    server.addConnection(new ConnectionContext({ id: 'session-a', socket }));
    const service = createDefaultWsQueueBoxServerService({
        inbox: new InMemoryQueueBox(new Map()),
        outbox: new InMemoryQueueBox(new Map()),
        socket: server,
        name: 'server-1'
    });
    onTestFinished(() => service.dispose());
    installRtcRttSystemTopic(service, options);
    return socket;
}
