import type { BlackBoxRallarConnectDiagnostics } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts';
import type { BlackBoxRallarRuntime } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime-contract.ts';
import {
    decodeBlackBoxRallarSendInput,
    decodeBlackBoxRallarWsSendInput
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-command-input.ts';
import type { RallarMessage } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
    afterEach,
    beforeEach,
    expect,
    it,
    vi
} from 'vitest';

import {
    events,
    facade,
    loadRuntime,
    resetFacade
} from './browser-rallar-runtime-test-harness.ts';

interface ChatMessagePayload {
    readonly text: string;
}

interface ConnectedMessageRuntime {
    readonly runtime: BlackBoxRallarRuntime;
    readonly connection: BlackBoxRallarConnectDiagnostics;
}

const roomRef: GroupRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-a',
    groupId: 'bb-group'
};

beforeEach(() => {
    resetFacade();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

it('preserves opaque application payloads while decoding the command envelope', () => {
    const payload = { nested: { arbitraryField: ['value', null] } };
    const realtime = decodeBlackBoxRallarSendInput(payload, 'realtime');
    const rtc = decodeBlackBoxRallarSendInput({ payload, ttlMs: '1200' }, 'messages.rtc');
    const ws = decodeBlackBoxRallarWsSendInput({ payload, ack: 'all-logical-recipients' });
    expect(realtime.data).toBe(payload);
    expect(rtc.payload).toBe(payload);
    expect(rtc.ttlMs).toBe(1200);
    expect(ws.payload).toBe(payload);
    expect(ws.ack).toBe('all-logical-recipients');
});

it('rejects incomplete room identity and unsupported acknowledgement modes at command ingress', () => {
    expect(() => decodeBlackBoxRallarSendInput({ roomRef: { groupId: 'room-1' } }, 'messages.rtc'))
        .toThrow('roomRef requires applicationId and groupId');
    expect(() => decodeBlackBoxRallarWsSendInput({ ack: 'unsupported' })).toThrow('ack mode is invalid');
});

it('applies scoped defaults and reports the connected room reference', async () => {
    const { connection } = await loadConnectedMessageRuntime('messages.rtc');

    expect(facade.records.defaultWrites).toContainEqual({
        applicationId: 'app-1',
        workspaceId: 'workspace-a',
        room: {
            roomId: 'bb-group',
            roomRef
        },
        realtime: {
            laneId: 'realtime'
        },
        rtc: {},
        diagnosticsPorts: {
            transportFaultPort: facade.rallar.diagnostics.faults,
            indexedDbOperationObserver: facade.rallar.diagnostics.storage
        }
    });
    expect(facade.records.roomJoins).toContainEqual(['bb-group', {
        timeoutMs: undefined,
        scope: {
            applicationId: 'app-1',
            workspaceId: 'workspace-a'
        }
    }]);
    expect(connection).toMatchObject({
        scope: {
            applicationId: 'app-1',
            workspaceId: 'workspace-a'
        },
        roomRef
    });
});

it('passes the connected room reference through RTC message sends', async () => {
    const { runtime } = await loadConnectedMessageRuntime('messages.rtc');

    await runtime.send({
        payload: { text: 'hello scoped room' },
        minSnapshotVersion: 42
    });

    expect(facade.records.rtcMessageSends[0]?.[0]).toEqual(expect.objectContaining({
        roomId: 'bb-group',
        roomRef,
        minSnapshotVersion: 42,
        payload: { text: 'hello scoped room' }
    }));
});

it('broadcasts untargeted realtime sends to every ready peer', async () => {
    facade.behavior.rtcStatus.mockReturnValue({
        sessionId: 'session-1',
        laneId: 'realtime',
        knownPeerIds: ['bob-session', 'charlie-session'],
        activePeerIds: ['bob-session', 'charlie-session'],
        peerIdsWithNoReconnectableLanes: [],
        readyPeerIds: ['bob-session', 'charlie-session'],
        peers: []
    });
    const { runtime } = await loadConnectedMessageRuntime();

    await runtime.send({
        roomId: 'bb-group',
        data: { text: 'hello ready peers' }
    });

    expect(facade.records.realtimeSends[0]?.[0]).toEqual(expect.objectContaining({
        roomId: 'bb-group',
        peerIds: ['bob-session', 'charlie-session'],
        data: { text: 'hello ready peers' }
    }));
});

it('subscribes before WebSocket sends and preserves message metadata', async () => {
    facade.behavior.wsMessageSend.mockResolvedValue({
        transport: 'ws',
        status: 'accepted',
        message: outboundMessage(),
        entries: []
    });
    const { runtime } = await loadConnectedMessageRuntime();

    const result = await sendWebSocketMessage(runtime);

    expect(result).toMatchObject({
        status: 'sent',
        transport: 'ws',
        roomId: 'bb-group',
        scope: 'room',
        typeId: 'room.manual.message',
        topicId: 'room.manual.message',
        contextId: 'bb-group',
        message: { text: 'hello over ws' }
    });
    expect(facade.records.wsMessageSubscriptions[0]?.[0]).toEqual({
        typeId: 'room.manual.message',
        topicId: 'room.manual.message'
    });
    expect(facade.records.wsMessageSends[0]?.[0]).toEqual(expect.objectContaining({
        roomId: 'bb-group',
        roomRef,
        scope: 'room',
        payload: { text: 'hello over ws' }
    }));
});

it('normalizes a transport failure before publishing its structured error', async () => {
    const { runtime } = await loadConnectedMessageRuntime();
    facade.behavior.realtimeSend.mockRejectedValue('transport rejected the send');
    await expect(runtime.send({ data: { text: 'hello' } })).rejects.toThrow('transport rejected the send');
    expect(events.find((event) => event.topic === 'rallar.browser.realtime.send_failed')?.error).toMatchObject({
        name: 'Error',
        message: 'transport rejected the send'
    });
});

it('keeps explicit workspace routing in WebSocket diagnostics and delivery', async () => {
    const { runtime } = await loadConnectedMessageRuntime();
    const alternateRoom = { ...roomRef, applicationId: 'app-2', workspaceId: 'workspace-b' };
    const result = await runtime.sendWs({
        applicationId: 'app-2',
        workspaceId: 'workspace-b',
        roomRef: alternateRoom,
        scope: 'room',
        payload: { text: 'scoped' },
        ack: 'receiver'
    });
    expect(result).toMatchObject({ applicationId: 'app-2', workspaceId: 'workspace-b', roomRef: alternateRoom });
    expect(facade.records.wsMessageSends.at(-1)?.[0]).toMatchObject({ roomRef: alternateRoom, ack: 'receiver' });
});

it('emits received WebSocket payloads and releases their subscription on close', async () => {
    facade.behavior.wsMessageSend.mockResolvedValue({
        transport: 'ws',
        status: 'accepted',
        message: outboundMessage(),
        entries: []
    });
    const { runtime } = await loadConnectedMessageRuntime();
    await sendWebSocketMessage(runtime);
    const handler = facade.records.wsMessageSubscriptions[0]?.[1];
    if (handler === undefined) {
        throw new Error('The WebSocket message subscription was not recorded.');
    }

    await handler(inboundMessage());

    expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
            kind: 'diagnostic',
            topic: 'rallar.browser.ws.subscribed',
            connection: 'aliceRtc',
            roomId: 'bb-group',
            typeId: 'room.manual.message',
            topicId: 'room.manual.message'
        }),
        expect.objectContaining({
            kind: 'message',
            topic: 'rallar.browser.ws.message',
            senderId: 'bob-session',
            data: { text: 'received over ws' }
        })
    ]));

    await runtime.close();
    expect(facade.records.wsMessageUnsubscribeCount).toBe(1);
});

it('emits typed channel deliveries once per selector and releases their subscription on close', async () => {
    const { runtime } = await loadConnectedMessageRuntime();

    await sendTypedMessage(runtime, 'handle-1');
    await sendTypedMessage(runtime, 'handle-2');

    expect(facade.records.typedChannelOpens).toHaveLength(2);
    expect(facade.records.typedWsHandlers).toHaveLength(1);
    expect(facade.records.typedRtcHandlers).toHaveLength(1);
    const wsHandler = facade.records.typedWsHandlers[0];
    const rtcHandler = facade.records.typedRtcHandlers[0];
    if (wsHandler === undefined || rtcHandler === undefined) {
        throw new Error('The typed channel subscriptions were not recorded.');
    }

    const deliveredOverWs = typedInboundMessage();
    const deliveredOverRtc: RallarMessage<ChatMessagePayload> = { ...deliveredOverWs, transport: 'rtc' };
    await wsHandler(deliveredOverWs.payload, deliveredOverWs);
    await rtcHandler(deliveredOverRtc.payload, deliveredOverRtc);

    expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
            kind: 'message',
            topic: 'rallar.browser.ws.message',
            transport: 'ws',
            typeId: 'alm.conformance',
            data: {
                msgId: 'ws-message-1',
                typeId: 'alm.conformance',
                topicId: 'alm',
                transport: 'ws',
                payload: { text: 'received over ws' }
            }
        }),
        expect.objectContaining({
            kind: 'message',
            topic: 'rallar.browser.messages.rtc.message',
            transport: 'messages.rtc',
            typeId: 'alm.conformance',
            data: {
                msgId: 'ws-message-1',
                typeId: 'alm.conformance',
                topicId: 'alm',
                transport: 'rtc',
                payload: { text: 'received over ws' }
            }
        })
    ]));

    await runtime.close();
    expect(facade.records.typedUnsubscribeCount).toBe(2);
});

it.each(['messages.rtc', 'messages.ws'] as const)(
    'subscribes the typed inbound channel at connect over %s so a receiver never has to send',
    async (transport) => {
        const { runtime } = await loadConnectedMessageRuntime(transport);

        expect(facade.records.typedChannelOpens).toEqual([{
            typeId: 'chat.message',
            topicId: 'chat',
            roomId: 'bb-group',
            roomRef
        }]);
        const wsHandler = facade.records.typedWsHandlers[0];
        const rtcHandler = facade.records.typedRtcHandlers[0];
        if (wsHandler === undefined || rtcHandler === undefined) {
            throw new Error('The connect-time typed channel subscriptions were not recorded.');
        }

        const deliveredOverWs = connectedTypedInboundMessage();
        const deliveredOverRtc: RallarMessage<ChatMessagePayload> = { ...deliveredOverWs, transport: 'rtc' };
        await wsHandler(deliveredOverWs.payload, deliveredOverWs);
        await rtcHandler(deliveredOverRtc.payload, deliveredOverRtc);

        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'message',
                topic: 'rallar.browser.ws.message',
                data: expect.objectContaining({ typeId: 'chat.message', payload: { text: 'received over ws' } })
            }),
            expect.objectContaining({
                kind: 'message',
                topic: 'rallar.browser.messages.rtc.message',
                data: expect.objectContaining({ typeId: 'chat.message', payload: { text: 'received over ws' } })
            })
        ]));

        await runtime.close();
        expect(facade.records.typedUnsubscribeCount).toBe(2);
    }
);

it('leaves a realtime connection without any typed inbound subscription', async () => {
    await loadConnectedMessageRuntime();

    expect(facade.records.typedChannelOpens).toEqual([]);
    expect(facade.records.typedWsHandlers).toEqual([]);
    expect(facade.records.typedRtcHandlers).toEqual([]);
});

async function loadConnectedMessageRuntime(
    transport?: 'messages.rtc' | 'messages.ws'
): Promise<ConnectedMessageRuntime> {
    const runtime = await loadRuntime();
    const connection = await runtime.connect({
        connection: 'aliceRtc',
        actor: 'alice',
        roomId: 'bb-group',
        roomRef,
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret',
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
            roomRef,
            transport,
            typeId: 'chat.message',
            topicId: 'chat'
        }
    });
    return { runtime, connection };
}

async function sendWebSocketMessage(runtime: BlackBoxRallarRuntime) {
    return await runtime.sendWs({
        applicationId: 'app-1',
        workspaceId: 'workspace-a',
        scope: 'room',
        roomId: 'bb-group',
        groupId: 'bb-group',
        typeId: 'room.manual.message',
        topicId: 'room.manual.message',
        contextId: 'bb-group',
        payload: { text: 'hello over ws' }
    });
}

async function sendTypedMessage(runtime: BlackBoxRallarRuntime, handleId: string) {
    return await runtime.sendMessage({
        connection: 'aliceRtc',
        carrier: 'rtc-with-ws-fallback',
        typeId: 'alm.conformance',
        topicId: 'alm',
        payload: { text: 'hello alm' },
        handleId
    });
}

function typedInboundMessage(): RallarMessage<ChatMessagePayload> {
    return {
        ...inboundMessage(),
        typeId: 'alm.conformance',
        topicId: 'alm'
    };
}

function connectedTypedInboundMessage(): RallarMessage<ChatMessagePayload> {
    return {
        ...inboundMessage(),
        typeId: 'chat.message',
        topicId: 'chat'
    };
}

function inboundMessage(): RallarMessage<ChatMessagePayload> {
    return {
        transport: 'ws',
        roomId: 'bb-group',
        senderId: 'bob-session',
        typeId: 'room.manual.message',
        topicId: 'room.manual.message',
        contextId: 'bb-group',
        resourceId: 'message-1',
        payload: { text: 'received over ws' },
        raw: outboundMessage(),
        receivedAtEpochMs: 1_000
    };
}

function outboundMessage(): ALMessage {
    return {
        id: {
            v: 2,
            msgId: 'ws-message-1',
            ts: 999,
            senderId: 'bob-session'
        },
        route: {
            topicId: 'room.manual.message',
            contextId: 'bb-group',
            resourceId: 'message-1'
        },
        payload: {
            typeId: 'room.manual.message',
            contentType: 'application/json',
            resource: '{"text":"received over ws"}'
        }
    };
}
