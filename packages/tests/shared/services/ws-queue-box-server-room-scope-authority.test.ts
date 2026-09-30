import { describe, expect, it, onTestFinished } from 'vitest';

import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import {
    ConnectionContext,
    JsonWebSocketServer
} from '@shared/websocket/json-web-socket-server.ts';

import { TestWebSocket } from '../websocket/test-web-socket.ts';

const SCOPE = { applicationId: 'app', workspaceId: 'workspace' };
const CONNECTIONS = [
    { connection: 'in the room scope', connectionScope: SCOPE, sent: 1 },
    {
        connection: 'in another workspace',
        connectionScope: { ...SCOPE, workspaceId: 'other' },
        sent: 0
    }
];

describe('WS room unicast scope authority', () => {
    it('refuses a room unicast admitted with a second recipient scope', async () => {
        const fixture = createFixture(SCOPE);
        const result = await fixture.service.enqueueOutboxIfAbsent(
            createRoomUnicast(),
            ['peer'],
            SCOPE
        );
        expect(result.verdict).toMatchObject({ kind: 'refused', reason: 'unauthorized' });
        expect(fixture.native.sent).toEqual([]);
    });

    it.each(CONNECTIONS)(
        'sends an admitted room unicast to a connection $connection only if it is in scope',
        async ({ connectionScope, sent }) => {
            const fixture = createFixture(connectionScope);
            const result = await fixture.service.enqueueOutboxIfAbsent(createRoomUnicast(), [
                'peer'
            ]);
            expect(result.verdict.kind).toBe('admitted');
            await expect.poll(() => fixture.settled.length).toBe(1);
            expect(fixture.native.sent).toHaveLength(sent);
        }
    );

    it.each(CONNECTIONS)(
        'live-sends a room unicast with no proven scope to a connection $connection',
        ({ connectionScope, sent }) => {
            const fixture = createFixture(connectionScope);
            expect(
                fixture.service.sendToTargetsWithResult({ message: createRoomUnicast() }).sentCount
            ).toBe(sent);
            expect(fixture.native.sent).toHaveLength(sent);
        }
    );
});

function createRoomUnicast(): ALMessage {
    return newALUnicastMessage(
        'server',
        { topicId: 'room.chat', resourceId: 'resource', contextId: 'room' },
        'peer',
        'chat.message.v1',
        {},
        {
            ttlMs: 30_000,
            groupRef: { ...SCOPE, groupId: 'room' }
        }
    );
}

function createFixture(connectionScope: StateScope) {
    const socket = new JsonWebSocketServer();
    const native = new TestWebSocket('ws://peer');
    native.open();
    socket.addConnection(new ConnectionContext({ id: 'peer', socket: native }));
    const settled: string[] = [];
    const service = createDefaultWsQueueBoxServerService({
        name: 'server',
        socket,
        outbox: new InMemoryQueueBox(),
        readAuthenticatedConnectionScope: () => ({
            scope: connectionScope,
            expiresAtEpochMs: Date.now() + 30_000
        }),
        outboundSettlements: (event) => {
            if (event.kind === 'attempt-settled') {
                settled.push(event.outcome);
            }
        }
    });
    onTestFinished(() => service.dispose());
    return { service, native, settled };
}
