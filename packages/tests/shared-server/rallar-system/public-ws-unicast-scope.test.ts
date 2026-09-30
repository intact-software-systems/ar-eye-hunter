import { describe, expect, it, onTestFinished } from 'vitest';

import { RallarServerWsRouter } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts';
import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

describe('public WS publication scope', () => {
    it('refuses the old unscoped public publication before enqueue', async () => {
        const outbox = new InMemoryQueueBox();
        const service = createDefaultWsQueueBoxServerService({
            readAuthenticatedConnectionScope: () => undefined,
            name: 'server',
            socket: new JsonWebSocketServer(),
            outbox
        });
        onTestFinished(() => service.dispose());
        const router = new RallarServerWsRouter(service);
        const message = newALUnicastMessage('server', { topicId: 'app.message', contextId: 'direct', resourceId: 'scope' }, 'peer', 'message.v1', {}, {
            ttlMs: 30_000
        });
        await expect(Reflect.apply(router.publish, router, [message, 'outbox'])).rejects.toBeInstanceOf(TypeError);
        expect(await outbox.getAllKeys()).toEqual([]);
    });
    it.each([undefined, null, {}, { message: null }, { message: {} }])(
        'rejects malformed public publication input %j before enqueue',
        async (publication) => {
            const outbox = new InMemoryQueueBox();
            const service = createDefaultWsQueueBoxServerService({
                readAuthenticatedConnectionScope: () => undefined,
                name: 'server',
                socket: new JsonWebSocketServer(),
                outbox
            });
            onTestFinished(() => service.dispose());
            const router = new RallarServerWsRouter(service);

            await expect(Reflect.apply(router.publish, router, [publication])).rejects.toBeInstanceOf(TypeError);
            expect(await outbox.getAllKeys()).toEqual([]);
        }
    );
    it.each([undefined, null, {}, { applicationId: 'app' }, { applicationId: 'app', workspaceId: '' }])(
        'fails a unicast with missing or malformed explicit scope %j before admission',
        async (scope) => {
            const outbox = new InMemoryQueueBox();
            const service = createDefaultWsQueueBoxServerService({
                readAuthenticatedConnectionScope: () => undefined,
                name: 'server',
                socket: new JsonWebSocketServer(),
                outbox
            });
            onTestFinished(() => service.dispose());
            const router = new RallarServerWsRouter(service);
            const message = newALUnicastMessage('server', { topicId: 'app.message', contextId: 'direct', resourceId: 'scope' }, 'peer', 'message.v1', {}, {
                ttlMs: 30_000
            });

            const result = await Reflect.apply(router.publish, router, [{ message, scope, fanout: 'outbox' }]);

            expect(result).toMatchObject({
                status: 'failed',
                reason: 'Public WS unicast requires explicit application and workspace scope'
            });
            expect(await outbox.getAllKeys()).toEqual([]);
        }
    );
    it('fails a group-addressed publication that also carries a scope', async () => {
        const outbox = new InMemoryQueueBox();
        const service = createDefaultWsQueueBoxServerService({
            readAuthenticatedConnectionScope: () => undefined,
            name: 'server',
            socket: new JsonWebSocketServer(),
            outbox
        });
        onTestFinished(() => service.dispose());
        const router = new RallarServerWsRouter(service);

        const result = await router.publish({ message: createRoomUnicast(), scope: SCOPE, fanout: 'outbox' });

        expect(result).toMatchObject({ status: 'failed', reason: 'A group-addressed publication takes its scope from targets.groupRef' });
        expect(await outbox.getAllKeys()).toEqual([]);
    });
    it('queues a room unicast without a DTO scope: its groupRef scopes it', async () => {
        const outbox = new InMemoryQueueBox();
        const service = createDefaultWsQueueBoxServerService({
            readAuthenticatedConnectionScope: () => undefined,
            name: 'server',
            socket: new JsonWebSocketServer(),
            outbox
        });
        onTestFinished(() => service.dispose());
        const router = new RallarServerWsRouter(service);

        const result = await router.publish({ message: createRoomUnicast(), fanout: 'outbox' });

        expect(result.status).toBe('queued-outbox');
        expect((await outbox.getAllKeys()).length).toBeGreaterThan(0);
    });
});

const SCOPE = { applicationId: 'app', workspaceId: 'workspace' };

function createRoomUnicast(): ALMessage {
    return newALUnicastMessage(
        'server',
        { topicId: 'room.chat', contextId: 'room', resourceId: 'scope' },
        'peer',
        'message.v1',
        {},
        {
            ttlMs: 30_000,
            groupRef: { ...SCOPE, groupId: 'room' },
            qos: { durability: { algo: 'local-outbox' } }
        }
    );
}
