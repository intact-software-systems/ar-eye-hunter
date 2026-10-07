import {
    createRallarServerAiResultPublisher,
    toRallarServerAiPublicationTarget,
    type RallarServerAiResultPublicationPort
} from '@shared-server/rallar-ai/rallar-server-ai-result-publication.ts';
import type { RallarServerWsFanout, RallarServerWsPublishResult } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import { RallarServerWsRouter } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';
import { describe, expect, it, onTestFinished } from 'vitest';

import { TestWebSocket } from '../../shared/websocket/test-web-socket.ts';
import { createRallarServerAiTestResult, RALLAR_SERVER_AI_TEST_ROOM_REF } from './rallar-server-ai-test-fixtures.ts';

const WORLD_SCOPE: StateScope = { applicationId: 'app-1', workspaceId: 'workspace-1' };

describe('Rallar server AI result publication', () => {
    it('publishes room results with canonical workspace identity', async () => {
        const publication = createPublicationCapture();
        const publish = createRallarServerAiResultPublisher({
            publication: publication.port,
            serverSenderId: 'ai-server'
        });

        await publish({
            result: createRallarServerAiTestResult(),
            roomRef: RALLAR_SERVER_AI_TEST_ROOM_REF,
            fanout: 'outbox'
        });

        expect(publication.message?.targets).toEqual({
            mode: 'broadcast',
            scope: 'room',
            groupRef: RALLAR_SERVER_AI_TEST_ROOM_REF
        });
        expect(publication.message?.route).toMatchObject({
            topicId: 'room.ai.generated',
            contextId: 'room-1',
            resourceId: 'generation-1'
        });
        expect(publication.fanout).toBe('outbox');
        expect(publication.message?.delivery).toEqual({ reliability: 'at-least-once', ack: 'receiver' });
    });

    it('hands a world result the scope it names, beside targets that name none', async () => {
        const publication = createPublicationCapture();
        const publish = createRallarServerAiResultPublisher({
            publication: publication.port,
            serverSenderId: 'ai-server'
        });

        await publish({
            result: createRallarServerAiTestResult(),
            scope: 'world',
            worldScope: WORLD_SCOPE
        });

        expect(publication.message?.targets).toEqual({
            mode: 'broadcast',
            scope: 'world'
        });
        expect(publication.message?.route.contextId).toBe('world');
        expect(publication.scope).toEqual(WORLD_SCOPE);
    });

    it.each(['world', 'all'] as const)(
        'requests no acknowledgement for a %s result, which names no logical recipients',
        async (scope) => {
            const publication = createPublicationCapture();
            const publish = createRallarServerAiResultPublisher({
                publication: publication.port,
                serverSenderId: 'ai-server'
            });

            await publish(
                scope === 'world'
                    ? { result: createRallarServerAiTestResult(), scope, worldScope: WORLD_SCOPE }
                    : { result: createRallarServerAiTestResult(), scope }
            );

            expect(publication.message?.delivery).toEqual({ reliability: 'at-least-once', ack: 'none' });
        }
    );

    it('requires canonical workspace identity for room publication', () => {
        expect(() => toRallarServerAiPublicationTarget('room', undefined))
            .toThrow('complete GroupRef');
        expect(toRallarServerAiPublicationTarget('world', undefined))
            .toEqual({ scope: 'world' });
    });

    it('does not publish when authorization denies the result', async () => {
        const publication = createPublicationCapture();
        const publish = createRallarServerAiResultPublisher({
            publication: publication.port,
            serverSenderId: 'ai-server',
            authorize: () => false
        });

        await expect(publish({
            result: createRallarServerAiTestResult(),
            scope: 'world',
            worldScope: WORLD_SCOPE
        })).rejects.toMatchObject({ code: 'unauthorized' });
        expect(publication.message).toBeUndefined();
    });
});

describe('a world result published through the server router', () => {
    it('is delivered to the live connections of the scope it names alone', async () => {
        const fixture = createScopedRouterFixture();
        const publish = createRallarServerAiResultPublisher({ publication: fixture.router, serverSenderId: 'ai-server' });

        const result = await publish({ result: createRallarServerAiTestResult(), scope: 'world', worldScope: WORLD_SCOPE, fanout: 'live-only' });

        expect(result.status).toBe('sent-live');
        expect(fixture.sockets.get('in-scope')!.sent).toHaveLength(1);
        expect(fixture.sockets.get('foreign')!.sent).toEqual([]);
    });

    it('is refused as a failed publish when it names no scope, and reaches no one', async () => {
        const fixture = createScopedRouterFixture();
        const publish = createRallarServerAiResultPublisher({ publication: fixture.router, serverSenderId: 'ai-server' });
        const scopeless = { result: createRallarServerAiTestResult(), scope: 'world' as const, worldScope: WORLD_SCOPE, fanout: 'live-only' as const };
        Reflect.deleteProperty(scopeless, 'worldScope');

        const result = await publish(scopeless);

        expect(result).toMatchObject({
            status: 'failed',
            reason: 'A world publication requires the application and workspace scope it reaches'
        });
        expect(fixture.sockets.get('in-scope')!.sent).toEqual([]);
        expect(fixture.sockets.get('foreign')!.sent).toEqual([]);
    });
});

interface ScopedRouterFixture {
    readonly router: RallarServerWsRouter;
    readonly sockets: ReadonlyMap<string, TestWebSocket>;
}

/** A router over two authenticated sockets: `in-scope` in the world scope, `foreign` in another application. */
function createScopedRouterFixture(): ScopedRouterFixture {
    const server = new JsonWebSocketServer();
    const sockets = new Map<string, TestWebSocket>();
    for (const sessionId of ['in-scope', 'foreign']) {
        const native = new TestWebSocket(`ws://${sessionId}`);
        native.open();
        server.addConnection(new ConnectionContext({ id: sessionId, socket: native }));
        sockets.set(sessionId, native);
    }
    const service = createDefaultWsQueueBoxServerService({
        outbox: new InMemoryQueueBox(new Map()),
        socket: server,
        name: 'ai-server',
        readAuthenticatedConnectionScope: (connection) => ({
            scope: connection.id === 'foreign' ? { ...WORLD_SCOPE, applicationId: 'other-app' } : WORLD_SCOPE,
            expiresAtEpochMs: Number.MAX_SAFE_INTEGER
        })
    });
    onTestFinished(() => service.dispose());
    return { router: new RallarServerWsRouter(service), sockets };
}

interface PublicationCapture {
    readonly port: RallarServerAiResultPublicationPort;
    readonly message: ALMessage | undefined;
    readonly fanout: RallarServerWsFanout | undefined;
    readonly scope: StateScope | undefined;
}

function createPublicationCapture(): PublicationCapture {
    let publishedMessage: ALMessage | undefined;
    let publishedFanout: RallarServerWsFanout | undefined;
    let publishedScope: StateScope | undefined;
    const port: RallarServerAiResultPublicationPort = {
        publish: async ({ message, fanout, scope }) => {
            publishedMessage = message;
            publishedFanout = fanout;
            publishedScope = scope;
            return successfulPublication(message, fanout);
        }
    };
    return {
        port,
        get message() {
            return publishedMessage;
        },
        get fanout() {
            return publishedFanout;
        },
        get scope() {
            return publishedScope;
        }
    };
}

function successfulPublication(
    message: ALMessage,
    fanout: RallarServerWsFanout | undefined
): RallarServerWsPublishResult {
    return {
        fanout: fanout ?? 'live-only',
        status: 'sent-live',
        message,
        sentCount: 1,
        entries: []
    };
}
