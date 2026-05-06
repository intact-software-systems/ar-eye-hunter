import { describe, expect, it, vi } from 'vitest';
import {
    AL_CONTROL_NACK_TYPE_ID,
    ALMessage,
    InMemoryQueueBox,
    newALBroadcastMessage,
    newALRoute,
    WsQueueBoxServerService,
    type WsServerTargetResolver,
} from '@shared/mod.ts';
import { RallarServerWsFacade } from '@shared-server/rallar-facade/ws-topic-router.ts';

describe('RallarServerWsFacade', () => {
    it('fans out implicit app topics to their declared targets', async () => {
        const { facade, socket } = createFacade();
        const message = newALBroadcastMessage(
            'peer-1',
            newALRoute('app.cursor', 'all', 'cursor-1'),
            'all',
            'cursor.position.v1',
            { x: 1, y: 2 },
            {
                exceptPeerIds: ['peer-1'],
            },
        );

        await facade.handle(message);

        expect(socket.sent.map((entry) => entry.connectionId).sort()).toEqual([
            'conn-2',
            'conn-3',
        ]);
        expect(
            socket.sent.every((entry) => entry.data.id.msgId === message.id.msgId),
        ).toBe(true);
    });

    it('reserves rallar topics for system middleware and sends a NACK', async () => {
        const { facade, socket } = createFacade();
        const message = newALBroadcastMessage(
            'peer-1',
            newALRoute('rallar.internal', 'all', 'secret-1'),
            'all',
            'internal.message.v1',
            { ok: false },
        );

        await facade.handle(message);

        expect(socket.sent).toHaveLength(1);
        expect(socket.sent[0].connectionId).toBe('conn-1');
        expect(socket.sent[0].data.payload.typeId).toBe(AL_CONTROL_NACK_TYPE_ID);
    });

    it('uses lightweight validators for registered topics', async () => {
        const { facade, socket } = createFacade();
        facade.defineTopic({
            topicId: 'app.todo',
            typeId: 'todo.item.updated.v1',
            validate: (value) =>
                typeof value === 'object' && value !== null && 'title' in value,
        });
        const message = newALBroadcastMessage(
            'peer-1',
            newALRoute('app.todo', 'all', 'todo-1'),
            'all',
            'todo.item.updated.v1',
            { done: true },
        );

        await facade.handle(message);

        expect(socket.sent).toHaveLength(1);
        expect(socket.sent[0].connectionId).toBe('conn-1');
        expect(socket.sent[0].data.payload.typeId).toBe(AL_CONTROL_NACK_TYPE_ID);
    });

    it('dispatches registered handlers and allows default fanout to be disabled', async () => {
        const { facade, socket } = createFacade();
        const handler = vi.fn();
        facade.defineTopic({
            topicId: 'app.todo',
            typeId: 'todo.item.updated.v1',
            fanout: 'none',
            validate: () => true,
        });
        facade.on({ topicId: 'app.todo', typeId: 'todo.item.updated.v1' }, handler);
        const message = newALBroadcastMessage(
            'peer-1',
            newALRoute('app.todo', 'all', 'todo-1'),
            'all',
            'todo.item.updated.v1',
            { title: 'Ship facade', done: false },
        );

        await facade.handle(message);

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler.mock.calls[0][0].payload).toEqual({
            title: 'Ship facade',
            done: false,
        });
        expect(socket.sent).toHaveLength(0);
    });

    it('can route registered topics through the QueueBox outbox', async () => {
        const { facade, service } = createFacade();
        const enqueue = vi.spyOn(service, 'enqueueOutboxIfAbsent');
        facade.defineTopic({
            topicId: 'app.todo',
            typeId: 'todo.item.updated.v1',
            fanout: 'outbox',
        });
        const message = newALBroadcastMessage(
            'peer-1',
            newALRoute('app.todo', 'all', 'todo-1'),
            'all',
            'todo.item.updated.v1',
            { title: 'Durable fanout', done: false },
        );

        await facade.handle(message);

        expect(enqueue).toHaveBeenCalledWith(message);
    });

    it('can require explicit topic definitions while still rejecting custom prefixes', async () => {
        const { facade } = createFacade({ allowImplicitUserTopics: false });

        facade.defineTopic({
            topicId: 'app.todo',
            typeId: 'todo.item.updated.v1',
        });

        expect(() =>
            facade.defineTopic({
                topicId: 'custom.todo',
                typeId: 'todo.item.updated.v1',
            })
        ).toThrow('Rallar user WS topic must start with app. or room.');
    });
});

function createFacade(
    options?: ConstructorParameters<typeof RallarServerWsFacade>[1],
) {
    const socket = createFakeWsServer();
    const service = new WsQueueBoxServerService(
        new InMemoryQueueBox(new Map()),
        new InMemoryQueueBox(new Map()),
        socket as never,
        'server-1',
        {
            targetResolver: createTargetResolver(),
        },
    );
    const facade = new RallarServerWsFacade(service, options);

    return {
        facade,
        service,
        socket,
    };
}

function createFakeWsServer() {
    const sent: Array<{ connectionId: string; data: ALMessage }> = [];

    return {
        sent,
        onMessageDo() {
            return this;
        },
        send(connectionId: string, data: ALMessage) {
            sent.push({ connectionId, data });
        },
    };
}

function createTargetResolver(): WsServerTargetResolver {
    const connectionIdByPeerId: Record<string, string> = {
        'peer-1': 'conn-1',
        'peer-2': 'conn-2',
        'peer-3': 'conn-3',
    };

    return {
        resolvePeerRecipients: (peerId: string) => {
            const connectionId = connectionIdByPeerId[peerId];
            return connectionId
                ? [
                    {
                        peerId,
                        connectionId,
                    },
                ]
                : [];
        },
        resolveBroadcastRecipients: () =>
            Object.entries(connectionIdByPeerId).map(([peerId, connectionId]) => ({
                peerId,
                connectionId,
            })),
    };
}
