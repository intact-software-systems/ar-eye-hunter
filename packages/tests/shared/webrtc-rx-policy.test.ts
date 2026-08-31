import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_CONTROL_ACK_TYPE_ID } from '@shared/al-contracts/al-control.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RtcEndpointFixture } from './rtc-endpoint-fixture.ts';

const endpoints: RtcEndpointFixture[] = [];

afterEach(() => {
    for (const endpoint of endpoints.splice(0)) {
        endpoint.close();
    }
    vi.restoreAllMocks();
});

describe('RTC receiver consumer dispatch', () => {
    it('delivers exclusive messages only to the matching consumer', async () => {
        const { sender, receiver } = createConnectedEndpoints();
        const receivedByType: string[] = [];
        receiver.streamer.onInboxMessageDo('tasks.job.v1', {
            onMessage: async (message) => {
                receivedByType.push(message.id.msgId);
            }
        });
        const message = exclusiveMessage();

        await sender.peer.channel.send(message);
        await sender.peer.channel.send(message);

        expect(receivedByType).toEqual([message.id.msgId]);
        expect(receiver.delivered).toEqual([]);
    });

    it('delivers exclusive messages to the wildcard consumer when no type consumer exists', async () => {
        const { sender, receiver } = createConnectedEndpoints();
        const message = exclusiveMessage();

        await sender.peer.channel.send(message);

        expect(receiver.delivered.map((entry) => entry.id.msgId)).toEqual([message.id.msgId]);
    });

    it('delivers shared messages to type and wildcard consumers and sends a correlated receiver ACK', async () => {
        const { sender, receiver } = createConnectedEndpoints();
        const receivedByType: string[] = [];
        receiver.streamer.onInboxMessageDo('chat.message.v1', {
            onMessage: async (message) => {
                receivedByType.push(message.id.msgId);
            }
        });
        const message = newALUnicastMessage(
            'sender',
            {
                topicId: 'chat',
                resourceId: 'message',
                contextId: 'conversation'
            },
            'receiver',
            'chat.message.v1',
            { text: 'hello' },
            {
                qos: { ack: { algo: 'hop', opts: { timeoutMs: 1000 } }, durability: { algo: 'volatile' } }
            }
        );

        await sender.peer.channel.send(message);

        expect(receivedByType).toEqual([message.id.msgId]);
        expect(receiver.delivered.map((entry) => entry.id.msgId)).toEqual([message.id.msgId]);
        const acknowledgements = receiver.sent.filter((entry) => entry.payload.typeId === AL_CONTROL_ACK_TYPE_ID);
        expect(acknowledgements).toHaveLength(1);
        expect(JSON.parse(acknowledgements[0].payload.resource)).toMatchObject({
            fromPeerId: 'receiver',
            toPeerId: 'sender',
            ackedMsgId: message.id.msgId,
            status: 'delivered'
        });
    });
});

interface ConnectedEndpoints {
    readonly sender: RtcEndpointFixture;
    readonly receiver: RtcEndpointFixture;
}

function createConnectedEndpoints(): ConnectedEndpoints {
    const sender = new RtcEndpointFixture('sender', 'receiver');
    const receiver = new RtcEndpointFixture('receiver', 'sender');
    endpoints.push(sender, receiver);
    sender.connect(receiver);
    receiver.connect(sender);
    return { sender, receiver };
}

function exclusiveMessage() {
    return newALUnicastMessage(
        'sender',
        {
            topicId: 'tasks',
            resourceId: 'job',
            contextId: 'queue'
        },
        'receiver',
        'tasks.job.v1',
        { text: 'claim me' },
        {
            qos: { ownership: { algo: 'exclusive' }, durability: { algo: 'volatile' } }
        }
    );
}
