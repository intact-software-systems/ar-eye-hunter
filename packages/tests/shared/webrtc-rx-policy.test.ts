import { Temporal } from '@js-temporal/polyfill';
import { beforeAll, describe, expect, it } from 'vitest';

if (!('Temporal' in globalThis)) {
    Object.assign(globalThis, { Temporal });
}

type SharedModule = typeof import('@shared/mod.ts');
type SharedMessage = import('@shared/mod.ts').ALMessage;

let shared: SharedModule;

beforeAll(async () => {
    shared = await import('@shared/mod.ts');
});

describe('WebRtcRxStreamerService QoS receive pipeline', () => {
    it('suppresses duplicate local delivery using the runtime dedup store', async () => {
        const manager = createFakeMulticastManager();
        const service = new shared.WebRtcRxStreamerService(
            new shared.InMemoryQueueBox(new Map()),
            manager as never,
            {
                sessionId: 'self'
            }
        );

        const received: string[] = [];
        service.onAllInboxMessagesDo(
            {
                onMessage: async (message) => {
                    received.push(message.id.msgId);
                }
            }
        );

        const msg = shared.newALUnicastMessage(
            'peer-1',
            {
                topicId: 'chat',
                resourceId: 'msg-1',
                contextId: 'conversation-1'
            },
            'self',
            'chat.private-text.v1',
            {
                text: 'hello'
            }
        );

        await (service as any).inboundRuntime.handleIncomingMessage(msg, 'peer-1');
        await (service as any).inboundRuntime.handleIncomingMessage(msg, 'peer-1');

        expect(received).toEqual([msg.id.msgId]);
    });

    it('delivers exclusive inbound messages to the matching local consumer', async () => {
        const manager = createFakeMulticastManager();
        const service = new shared.WebRtcRxStreamerService(
            new shared.InMemoryQueueBox(new Map()),
            manager as never,
            {
                sessionId: 'self'
            }
        );

        const receivedByType: string[] = [];
        const receivedByWildcard: string[] = [];
        service.onInboxMessageDo(
            'tasks.job.v1',
            {
                onMessage: async (message) => {
                    receivedByType.push(message.id.msgId);
                }
            }
        );
        service.onAllInboxMessagesDo(
            {
                onMessage: async (message) => {
                    receivedByWildcard.push(message.id.msgId);
                }
            }
        );

        const msg = shared.newALUnicastMessage(
            'peer-1',
            {
                topicId: 'tasks',
                resourceId: 'job-1',
                contextId: 'queue-1'
            },
            'self',
            'tasks.job.v1',
            {
                text: 'claim me'
            },
            {
                qos: {
                    ownership: {
                        algo: 'exclusive'
                    }
                }
            }
        );

        await (service as any).inboundRuntime.handleIncomingMessage(msg, 'peer-1');

        expect(receivedByType).toEqual([msg.id.msgId]);
        expect(receivedByWildcard).toEqual([]);
    });

    it('falls back to the catch-all RTC consumer for exclusive inbound messages', async () => {
        const manager = createFakeMulticastManager();
        const service = new shared.WebRtcRxStreamerService(
            new shared.InMemoryQueueBox(new Map()),
            manager as never,
            {
                sessionId: 'self'
            }
        );

        const received: string[] = [];
        service.onAllInboxMessagesDo(
            {
                onMessage: async (message) => {
                    received.push(message.id.msgId);
                }
            }
        );

        const msg = shared.newALUnicastMessage(
            'peer-1',
            {
                topicId: 'tasks',
                resourceId: 'job-2',
                contextId: 'queue-1'
            },
            'self',
            'tasks.job.v1',
            {
                text: 'route through wildcard'
            },
            {
                qos: {
                    ownership: {
                        algo: 'exclusive'
                    }
                }
            }
        );

        await (service as any).inboundRuntime.handleIncomingMessage(msg, 'peer-1');

        expect(received).toEqual([msg.id.msgId]);
    });

    it('buffers ordered gaps and releases them once the missing sequence arrives', async () => {
        const manager = createFakeMulticastManager({
            overlayNeighborPeerIds: ['peer-2'],
            connectedPeerIds: ['peer-1', 'peer-2'],
            groupMemberPeerIds: ['self', 'peer-1', 'peer-2']
        });
        const service = new shared.WebRtcRxStreamerService(
            new shared.InMemoryQueueBox(new Map()),
            manager as never,
            {
                sessionId: 'self'
            }
        );

        const deliveredTexts: string[] = [];
        service.onAllInboxMessagesDo(
            {
                onMessage: async (message) => {
                    const payload = JSON.parse(message.payload.resource) as { text: string; };
                    deliveredTexts.push(payload.text);
                }
            }
        );

        const seq2 = shared.newALMulticastMessage(
            'peer-1',
            {
                topicId: 'chat',
                resourceId: 'msg-2',
                contextId: 'group-1'
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'two'
            },
            {
                seq: 2,
                reliability: 'at-least-once'
            }
        );

        const seq1 = shared.newALMulticastMessage(
            'peer-1',
            {
                topicId: 'chat',
                resourceId: 'msg-3',
                contextId: 'group-1'
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'one'
            },
            {
                seq: 1,
                reliability: 'at-least-once'
            }
        );

        await (service as any).inboundRuntime.handleIncomingMessage(seq2, 'peer-1');

        expect(deliveredTexts).toEqual([]);
        expect(manager.outboundControlMessages.map((msg) => msg.payload.typeId)).toEqual([
            shared.AL_CONTROL_NACK_TYPE_ID,
            shared.AL_CONTROL_REPAIR_TYPE_ID
        ]);

        await (service as any).inboundRuntime.handleIncomingMessage(seq1, 'peer-1');

        expect(deliveredTexts).toEqual(['one', 'two']);
        expect(manager.forwardedMessages).toContain(seq2);
        expect(manager.forwardedMessages).toContain(seq1);
    });

    it('emits ack control messages for receiver-ack unicast delivery', async () => {
        const manager = createFakeMulticastManager();
        const service = new shared.WebRtcRxStreamerService(
            new shared.InMemoryQueueBox(new Map()),
            manager as never,
            {
                sessionId: 'self'
            }
        );

        service.onAllInboxMessagesDo(
            {
                onMessage: async () => Promise.resolve()
            }
        );

        const msg = shared.newALUnicastMessage(
            'peer-1',
            {
                topicId: 'chat',
                resourceId: 'msg-4',
                contextId: 'conversation-1'
            },
            'self',
            'chat.private-text.v1',
            {
                text: 'ack please'
            },
            {
                qos: {
                    ack: {
                        algo: 'hop',
                        opts: {
                            timeoutMs: 1_000
                        }
                    }
                }
            }
        );

        await (service as any).inboundRuntime.handleIncomingMessage(msg, 'peer-1');

        expect(manager.outboundControlMessages.some((control) => control.payload.typeId === shared.AL_CONTROL_ACK_TYPE_ID)).toBe(true);
    });

    it('aggregates subtree acknowledgements before acking upstream', async () => {
        const manager = createFakeMulticastManager({
            overlayNeighborPeerIds: ['peer-2', 'peer-3'],
            connectedPeerIds: ['peer-1', 'peer-2', 'peer-3'],
            groupMemberPeerIds: ['self', 'peer-1', 'peer-2', 'peer-3']
        });
        const service = new shared.WebRtcRxStreamerService(
            new shared.InMemoryQueueBox(new Map()),
            manager as never,
            {
                sessionId: 'self'
            }
        );

        service.onAllInboxMessagesDo(
            {
                onMessage: async () => Promise.resolve()
            }
        );

        const msg = shared.newALMulticastMessage(
            'peer-1',
            {
                topicId: 'chat',
                resourceId: 'msg-5',
                contextId: 'group-1'
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'wait for children'
            },
            {
                reliability: 'at-least-once',
                ack: 'all-logical-recipients'
            }
        );

        await (service as any).inboundRuntime.handleIncomingMessage(msg, 'peer-1');

        expect(manager.outboundControlMessages).toEqual([]);

        const childAck1 = shared.newALAckControlMessage('peer-2', 'self', msg.id.msgId, 'delivered');
        await (service as any).inboundRuntime.handleIncomingMessage(childAck1, 'peer-2');
        expect(manager.outboundControlMessages).toEqual([]);

        const childAck2 = shared.newALAckControlMessage('peer-3', 'self', msg.id.msgId, 'delivered');
        await (service as any).inboundRuntime.handleIncomingMessage(childAck2, 'peer-3');

        expect(manager.outboundControlMessages).toHaveLength(1);
        expect(manager.outboundControlMessages[0].payload.typeId).toBe(shared.AL_CONTROL_ACK_TYPE_ID);

        const payload = JSON.parse(manager.outboundControlMessages[0].payload.resource) as {
            status: string;
            toPeerId: string;
            ackedMsgId: string;
        };
        expect(payload.status).toBe('subtree-complete');
        expect(payload.toPeerId).toBe('peer-1');
        expect(payload.ackedMsgId).toBe(msg.id.msgId);
    });
});

function createFakeMulticastManager(
    options?: Readonly<{
        connectedPeerIds?: readonly string[];
        groupMemberPeerIds?: readonly string[];
        overlayNeighborPeerIds?: readonly string[];
    }>
) {
    const connectedPeerIds = options?.connectedPeerIds ?? ['peer-1'];
    const groupMemberPeerIds = options?.groupMemberPeerIds ?? ['self', 'peer-1'];
    const overlayNeighborPeerIds = options?.overlayNeighborPeerIds ?? [];

    const outboundControlMessages: SharedMessage[] = [];
    const forwardedMessages: SharedMessage[] = [];

    return {
        planIncomingMessage: (
            msg: SharedMessage,
            fromPeerId?: string,
            runtime?: { dedupStore?: unknown; orderingStore?: unknown; }
        ) => shared.planALMessageHandling(
            msg,
            {
                selfPeerId: 'self',
                fromPeerId,
                connectedPeerIds,
                groupMemberPeerIds,
                overlayNeighborPeerIds,
                dedupStore: runtime?.dedupStore as any,
                orderingStore: runtime?.orderingStore as any
            }
        ),
        enqueueIfAbsent: async (msg: SharedMessage) => {
            outboundControlMessages.push(msg);
            return [];
        },
        acceptControlMessage: async () => Promise.resolve(),
        forwardIfRequired: async (msg: SharedMessage) => {
            forwardedMessages.push(msg);
            return [];
        },
        outboundControlMessages,
        forwardedMessages
    };
}

function groupRef(groupId: string) {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId
    };
}
