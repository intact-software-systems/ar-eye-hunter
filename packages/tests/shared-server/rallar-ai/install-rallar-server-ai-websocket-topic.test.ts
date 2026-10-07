import {
    installRallarServerAiWebSocketTopic,
    type RallarServerAiWebSocketConfig,
    type RallarServerAiWebSocketPort
} from '@shared-server/rallar-ai/install-rallar-server-ai-websocket-topic.ts';
import { RallarServerWsRouter } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts';
import { newALRoute, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { createRallarAiMockProvider } from '@shared/rallar-ai/mod.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';
import { describe, expect, expectTypeOf, it, onTestFinished } from 'vitest';
import { TestWebSocket } from '../../shared/websocket/test-web-socket.ts';
import {
    createRallarServerAiTestRequest,
    createRallarServerAiTestRequestJson,
    createRallarServerAiTestService,
    createRallarServerAiTestWebSocket
} from './rallar-server-ai-test-fixtures.ts';

const TEST_WEBSOCKET_CONFIG: RallarServerAiWebSocketConfig = {
    requestTopicId: 'room.ai.generate',
    requestTypeId: 'rallar.ai.generate-json.request.v1',
    resultTopicId: 'room.ai.generated',
    resultTypeId: 'rallar.ai.generate-json.result.v1',
    requestFanout: 'none',
    resultFanout: 'outbox',
    resultScope: 'room',
    maxPayloadBytes: 16_384,
    serverSenderId: 'rallar-ai-server'
};

describe('Rallar server AI WebSocket topic', () => {
    it('accepts the current server WebSocket router surface directly', () => {
        expectTypeOf<RallarServerWsRouter>().toMatchTypeOf<RallarServerAiWebSocketPort>();
    });

    it('registers the request contract before handling and publishing room results', async () => {
        const websocket = createRallarServerAiTestWebSocket();
        const unregister = installRallarServerAiWebSocketTopic({
            websocket: websocket.port,
            serverAi: createRallarServerAiTestService({
                provider: createRallarAiMockProvider({ value: { kind: 'spawn' } })
            }),
            config: TEST_WEBSOCKET_CONFIG
        });

        await websocket.invoke(createRallarServerAiTestRequest());

        expect(websocket.topics).toHaveLength(1);
        expect(websocket.topics[0]).toMatchObject({
            topicId: 'room.ai.generate',
            typeId: 'rallar.ai.generate-json.request.v1',
            fanout: 'none',
            maxPayloadBytes: 16_384
        });
        expect(websocket.selectors).toEqual([{
            topicId: 'room.ai.generate',
            typeId: 'rallar.ai.generate-json.request.v1'
        }]);
        expect(websocket.publications).toHaveLength(1);
        expect(websocket.publications[0]?.fanout).toBe('outbox');
        expect(websocket.publications[0]?.message.targets).toMatchObject({
            mode: 'broadcast',
            scope: 'room',
            groupRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1'
            }
        });
        expect(websocket.publications[0]?.message.payload.resource)
            .toContain('"kind":"spawn"');
        expect(unregister()).toBe(true);
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

    it('fails topic authorization closed', async () => {
        const websocket = createRallarServerAiTestWebSocket();
        installRallarServerAiWebSocketTopic({
            websocket: websocket.port,
            serverAi: createRallarServerAiTestService({
                provider: createRallarAiMockProvider({ value: { kind: 'spawn' } })
            }),
            config: TEST_WEBSOCKET_CONFIG,
            authorize: () => false
        });
        const topic = websocket.topics[0];
        if (topic === undefined) {
            throw new Error('RallarAI topic was not registered.');
        }

        await expect(topic.authorize(
            { payload: createRallarServerAiTestRequest() },
            { senderId: 'peer-1', roomId: 'room-1' }
        )).resolves.toBe(false);
    });

    it('publishes a world result to the authenticated scope of the asking session alone', async () => {
        const scope = { applicationId: 'app-1', workspaceId: 'workspace-1' };
        const socket = new JsonWebSocketServer();
        const sockets = new Map<string, TestWebSocket>();
        for (const sessionId of ['in-scope', 'foreign']) {
            const native = new TestWebSocket(`ws://${sessionId}`);
            native.open();
            socket.addConnection(new ConnectionContext({ id: sessionId, socket: native }));
            sockets.set(sessionId, native);
        }
        const service = createDefaultWsQueueBoxServerService({
            outbox: new InMemoryQueueBox(new Map()),
            socket,
            name: 'rallar-ai-server',
            readAuthenticatedConnectionScope: (connection) => ({
                scope: connection.id === 'foreign' ? { ...scope, applicationId: 'app-2' } : scope,
                expiresAtEpochMs: Number.MAX_SAFE_INTEGER
            }),
            targetResolver: {
                resolveBroadcastRecipients: () => [...sockets.keys()].map((peerId) => ({ peerId, connectionId: peerId }))
            }
        });
        onTestFinished(() => service.dispose());
        const router = new RallarServerWsRouter(service, {});
        installRallarServerAiWebSocketTopic({
            websocket: router,
            serverAi: createRallarServerAiTestService({
                provider: createRallarAiMockProvider({ value: { kind: 'spawn' } })
            }),
            config: {
                ...TEST_WEBSOCKET_CONFIG,
                requestTopicId: 'app.ai.generate',
                resultTopicId: 'app.ai.generated',
                resultFanout: 'live-only',
                resultScope: 'world'
            }
        });
        const request = newALUnicastMessage(
            'asker',
            newALRoute('app.ai.generate', 'world', 'request-1'),
            'rallar-ai-server',
            TEST_WEBSOCKET_CONFIG.requestTypeId,
            createRallarServerAiTestRequestJson()
        );

        await router.route(request, { kind: 'ws-client', peerId: 'asker', authenticatedScope: scope });

        expect(sockets.get('in-scope')!.sent).toHaveLength(1);
        expect(sockets.get('in-scope')!.sent[0]).toContain('app.ai.generated');
        expect(sockets.get('foreign')!.sent).toEqual([]);
    });

    it('fails closed when room publication lacks workspace identity', async () => {
        const websocket = createRallarServerAiTestWebSocket();
        installRallarServerAiWebSocketTopic({
            websocket: websocket.port,
            serverAi: createRallarServerAiTestService({
                provider: createRallarAiMockProvider({ value: { kind: 'spawn' } })
            }),
            config: TEST_WEBSOCKET_CONFIG
        });

        await expect(websocket.invoke(
            createRallarServerAiTestRequest(),
            { senderId: 'peer-1', roomId: 'room-1' }
        )).rejects.toThrow('complete GroupRef');
        expect(websocket.publications).toEqual([]);
    });
});
