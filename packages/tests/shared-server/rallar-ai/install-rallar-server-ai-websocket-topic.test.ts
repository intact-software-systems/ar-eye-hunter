import {
    installRallarServerAiWebSocketTopic,
    type RallarServerAiWebSocketConfig,
    type RallarServerAiWebSocketPort
} from '@shared-server/rallar-ai/install-rallar-server-ai-websocket-topic.ts';
import { RallarServerWsRouter } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts';
import { newALBroadcastMessage, newALRoute, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { createRallarAiMockProvider } from '@shared/rallar-ai/mod.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';
import { describe, expect, expectTypeOf, it, onTestFinished } from 'vitest';
import { TestWebSocket } from '../../shared/websocket/test-web-socket.ts';
import {
    createRallarServerAiTestMessage,
    createRallarServerAiTestRequestJson,
    createRallarServerAiTestService,
    createRallarServerAiTestWebSocket,
    RALLAR_SERVER_AI_TEST_ROOM_REF
} from './rallar-server-ai-test-fixtures.ts';

const TEST_WEBSOCKET_CONFIG: RallarServerAiWebSocketConfig = {
    requestTopicId: 'room.ai.generate',
    requestTypeId: 'rallar.ai.generate-json.request.v1',
    requestScope: 'room',
    requestFanout: 'none',
    replyTypeId: 'rallar.ai.generate-json.reply.v1',
    replyFanout: 'outbox',
    maxPayloadBytes: 16_384,
    serverSenderId: 'rallar-ai-server'
};

describe('Rallar server AI WebSocket topic', () => {
    it('accepts the current server WebSocket router surface directly', () => {
        expectTypeOf<RallarServerWsRouter>().toMatchTypeOf<RallarServerAiWebSocketPort>();
    });

    it('defines the request topic and replies to the asking session alone under the request\'s correlation', async () => {
        const websocket = createRallarServerAiTestWebSocket();
        const unregister = installRallarServerAiWebSocketTopic({
            websocket: websocket.port,
            serverAi: createRallarServerAiTestService({
                provider: createRallarAiMockProvider({ value: { kind: 'spawn' } })
            }),
            config: TEST_WEBSOCKET_CONFIG
        });
        const request = createRallarServerAiTestMessage();

        await websocket.invoke(request);

        expect(websocket.topics).toHaveLength(1);
        expect(websocket.topics[0]).toMatchObject({
            topicId: 'room.ai.generate',
            typeId: 'rallar.ai.generate-json.request.v1',
            scope: 'room',
            fanout: 'none',
            maxPayloadBytes: 16_384
        });
        expect(websocket.selectors).toEqual([{
            topicId: 'room.ai.generate',
            typeId: 'rallar.ai.generate-json.request.v1'
        }]);
        expect(websocket.publications).toHaveLength(1);
        const reply = websocket.publications[0]!;
        expect(reply.fanout).toBe('outbox');
        expect(reply.scope).toBeUndefined();
        expect(reply.message.id.senderId).toBe('rallar-ai-server');
        expect(reply.message.payload.typeId).toBe('rallar.ai.generate-json.reply.v1');
        expect(reply.message.route).toMatchObject({ topicId: 'room.ai.generate', contextId: 'room-1' });
        expect(reply.message.targets).toEqual({
            mode: 'unicast',
            toPeerId: 'peer-1',
            groupRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' }
        });
        expect(reply.message.actions).toEqual({ corrId: request.raw.id.msgId, replyToMsgId: request.raw.id.msgId });
        expect(JSON.parse(reply.message.payload.resource)).toMatchObject({
            requestId: 'request-1',
            value: { kind: 'spawn' }
        });
        expect(unregister()).toBe(true);
    });

    it('replies to a room broadcast request with a custom context in the room id', async () => {
        const websocket = createRallarServerAiTestWebSocket();
        installRallarServerAiWebSocketTopic({
            websocket: websocket.port,
            serverAi: createRallarServerAiTestService({
                provider: createRallarAiMockProvider({ value: { kind: 'spawn' } })
            }),
            config: TEST_WEBSOCKET_CONFIG
        });
        const unicast = createRallarServerAiTestMessage();
        const request = {
            payload: unicast.payload,
            raw: newALBroadcastMessage(
                'peer-1',
                newALRoute('room.ai.generate', 'custom-context', 'request-1'),
                'room',
                unicast.raw.payload.typeId,
                createRallarServerAiTestRequestJson('request-1'),
                { groupRef: RALLAR_SERVER_AI_TEST_ROOM_REF }
            )
        };

        await websocket.invoke(request);

        expect(websocket.publications).toHaveLength(1);
        expect(websocket.publications[0]!.message.route.contextId).toBe(RALLAR_SERVER_AI_TEST_ROOM_REF.groupId);
        expect(websocket.publications[0]!.message.targets).toMatchObject({ mode: 'unicast', toPeerId: 'peer-1' });
    });

    it('validates current request JSON before the handler can run', () => {
        const websocket = createRallarServerAiTestWebSocket();
        installRallarServerAiWebSocketTopic({
            websocket: websocket.port,
            serverAi: createRallarServerAiTestService({
                provider: createRallarAiMockProvider({ value: { kind: 'spawn' } })
            }),
            config: TEST_WEBSOCKET_CONFIG
        });
        const topic = websocket.topics[0];
        if (topic === undefined) {
            throw new Error('RallarAI topic was not registered.');
        }

        expect(topic.validate(createRallarServerAiTestRequestJson())).toBe(true);
        expect(topic.validate({ prompt: 'missing schema' })).toBe(false);
    });

    it('replies to a request that names no group in the asking session\'s authenticated scope, and to nobody else', async () => {
        const scope = { applicationId: 'app-1', workspaceId: 'workspace-1' };
        const { router, sockets } = createRouterWithSessions(['asker', 'neighbour']);
        installRallarServerAiWebSocketTopic({
            websocket: router,
            serverAi: createRallarServerAiTestService({
                provider: createRallarAiMockProvider({ value: { kind: 'spawn' } })
            }),
            config: { ...TEST_WEBSOCKET_CONFIG, requestTopicId: 'app.ai.generate', requestScope: 'app', replyFanout: 'live-only' }
        });

        await router.route(worldRequest(), { kind: 'ws-client', peerId: 'asker', authenticatedScope: scope });

        expect(sockets.get('asker')!.sent).toHaveLength(1);
        expect(sockets.get('asker')!.sent[0]).toContain('rallar.ai.generate-json.reply.v1');
        expect(sockets.get('neighbour')!.sent).toEqual([]);
    });

    it('sends no reply when authorization refuses the request', async () => {
        const scope = { applicationId: 'app-1', workspaceId: 'workspace-1' };
        const { router, sockets } = createRouterWithSessions(['asker']);
        installRallarServerAiWebSocketTopic({
            websocket: router,
            serverAi: createRallarServerAiTestService({
                provider: createRallarAiMockProvider({ value: { kind: 'spawn' } })
            }),
            config: { ...TEST_WEBSOCKET_CONFIG, requestTopicId: 'app.ai.generate', requestScope: 'app', replyFanout: 'live-only' },
            authorize: () => false
        });

        await router.route(worldRequest(), { kind: 'ws-client', peerId: 'asker', authenticatedScope: scope });

        expect(sockets.get('asker')!.sent.filter((frame) => frame.includes('rallar.ai.generate-json.reply.v1')))
            .toEqual([]);
    });
});

function createRouterWithSessions(sessionIds: readonly string[]) {
    const scope = { applicationId: 'app-1', workspaceId: 'workspace-1' };
    const socket = new JsonWebSocketServer();
    const sockets = new Map<string, TestWebSocket>();
    for (const sessionId of sessionIds) {
        const native = new TestWebSocket(`ws://${sessionId}`);
        native.open();
        socket.addConnection(new ConnectionContext({ id: sessionId, socket: native }));
        sockets.set(sessionId, native);
    }
    const service = createDefaultWsQueueBoxServerService({
        inboundVolatileStores: undefined,
        outbox: new InMemoryQueueBox(new Map()),
        socket,
        name: 'rallar-ai-server',
        readAuthenticatedConnectionScope: () => ({ scope, expiresAtEpochMs: Number.MAX_SAFE_INTEGER }),
        targetResolver: {
            resolveBroadcastRecipients: () => [...sockets.keys()].map((peerId) => ({ peerId, connectionId: peerId }))
        }
    });
    onTestFinished(() => service.dispose());
    return { router: new RallarServerWsRouter(service, { sendNacks: false }), sockets };
}

function worldRequest() {
    return newALUnicastMessage(
        'asker',
        newALRoute('app.ai.generate', 'world', 'request-1'),
        'rallar-ai-server',
        TEST_WEBSOCKET_CONFIG.requestTypeId,
        createRallarServerAiTestRequestJson()
    );
}
