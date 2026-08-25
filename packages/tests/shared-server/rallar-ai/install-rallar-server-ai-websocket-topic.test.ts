import {
    installRallarServerAiWebSocketTopic,
    type RallarServerAiWebSocketConfig,
    type RallarServerAiWebSocketPort
} from '@shared-server/rallar-ai/install-rallar-server-ai-websocket-topic.ts';
import type { RallarServerWsRouter } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts';
import { createRallarAiMockProvider } from '@shared/rallar-ai/mod.ts';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { createRallarServerAiTestRequest, createRallarServerAiTestService, createRallarServerAiTestWebSocket } from './rallar-server-ai-test-fixtures.ts';

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

        expect(topic.validate(createRallarServerAiTestRequest())).toBe(true);
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
