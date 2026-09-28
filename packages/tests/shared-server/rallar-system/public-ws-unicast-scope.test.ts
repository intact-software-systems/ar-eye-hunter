import { describe, expect, it, onTestFinished } from 'vitest';

import { RallarServerWsRouter } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts';
import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

describe('public WS publication scope', () => {
    it('refuses the old unscoped public publication before enqueue', async () => {
        const outbox = new InMemoryQueueBox();
        const service = createDefaultWsQueueBoxServerService({ name: 'server', socket: new JsonWebSocketServer(), outbox });
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
            const service = createDefaultWsQueueBoxServerService({ name: 'server', socket: new JsonWebSocketServer(), outbox });
            onTestFinished(() => service.dispose());
            const router = new RallarServerWsRouter(service);

            await expect(Reflect.apply(router.publish, router, [publication])).rejects.toBeInstanceOf(TypeError);
            expect(await outbox.getAllKeys()).toEqual([]);
        }
    );
    it.each([undefined, null, {}, { applicationId: 'app' }, { applicationId: 'app', workspaceId: '' }])(
        'rejects missing or malformed explicit scope %j before admission',
        async (scope) => {
            const outbox = new InMemoryQueueBox();
            const service = createDefaultWsQueueBoxServerService({ name: 'server', socket: new JsonWebSocketServer(), outbox });
            onTestFinished(() => service.dispose());
            const router = new RallarServerWsRouter(service);
            const message = newALUnicastMessage('server', { topicId: 'app.message', contextId: 'direct', resourceId: 'scope' }, 'peer', 'message.v1', {}, {
                ttlMs: 30_000
            });

            const result = await Reflect.apply(router.publish, router, [{ message, scope, fanout: 'outbox' }]);

            expect(result.status).toBe('skipped');
            expect(await outbox.getAllKeys()).toEqual([]);
        }
    );
});
