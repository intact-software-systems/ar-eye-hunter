import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import {
    ConnectionContext,
    InMemoryQueueBox,
    JsonWebSocketServer,
    newALRoute,
    newALUntargetedMessage
} from '@shared/mod.ts';
import { Either } from '@shared/resilience/Either.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';

import { SimulatedWebSocket } from '../../../../shared/native-websocket-fixture.ts';

describe('WS server inbound identity', () => {
    it('rejects a forged sender and preserves an exact matching non-CRDT message', async () => {
        const server = new JsonWebSocketServer();
        const socket = new SimulatedWebSocket('ws://test.invalid');
        await socket.open();
        server.addConnection(new ConnectionContext({ id: 'session-attacker', socket }));
        const inboundDiagnostics: ALInboundRuntimeDiagnosticsEvent[] = [];
        const service = createDefaultWsQueueBoxServerService({
            inboundVolatileStores: undefined,
            outbox: new InMemoryQueueBox(),
            socket: server,
            readAuthenticatedConnectionScope: (connection) =>
                server.connections.get(connection.id) === connection
                    ? { scope: { applicationId: 'app-1', workspaceId: 'workspace-1' }, expiresAtEpochMs: Number.MAX_SAFE_INTEGER }
                    : undefined,
            name: 'server-1',
            inboundDiagnostics: (event) => inboundDiagnostics.push(event)
        });
        const received: ALMessage[] = [];
        service.onAnyInboxMessageDo('identity-test', {
            onMessage: (message) => {
                received.push(message);
                return Promise.resolve();
            }
        });
        const forged = createIdentityMessage('session-victim', 'forged-message');
        const matching = createIdentityMessage('session-attacker', 'matching-message');
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            await socket.receive(JSON.stringify(forged));
            expect(received).toEqual([]);

            await socket.receive(JSON.stringify(matching));
            await expect.poll(() => received).toEqual([matching]);

            // The forged message never reached the runtime, so only the admitted one is named here.
            expect(
                inboundDiagnostics.filter((event) => event.kind === 'admission-outcome')
            ).toEqual([expect.objectContaining({
                msgId: 'matching-message',
                typeId: 'test.identity.v1',
                outcome: 'committed',
                reason: 'admitted'
            })]);
        }
        finally {
            try {
                await service.dispose();
            }
            finally {
                consoleError.mockRestore();
            }
        }
    });

    it('rejects malformed current envelopes before admission policy runs', async () => {
        const server = new JsonWebSocketServer();
        const socket = new SimulatedWebSocket('ws://test.invalid');
        await socket.open();
        server.addConnection(new ConnectionContext({ id: 'session-1', socket }));
        const admittedMessages: ALMessage[] = [];
        const service = createDefaultWsQueueBoxServerService({
            inboundVolatileStores: undefined,
            readAuthenticatedConnectionScope: () => ({
                scope: { applicationId: 'app-1', workspaceId: 'workspace-1' },
                expiresAtEpochMs: Number.MAX_SAFE_INTEGER
            }),
            outbox: new InMemoryQueueBox(),
            socket: server,
            name: 'server-1',
            authorizeInboundMessage: (message) => {
                admittedMessages.push(message);
                return Either.ofRight(message);
            }
        });
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            await socket.receive(JSON.stringify({
                id: {
                    v: 3,
                    msgId: 'malformed-message',
                    ts: 1,
                    senderId: 'session-1'
                },
                payload: {
                    typeId: 'test.identity.v1',
                    resource: '{}'
                }
            }));

            expect(admittedMessages).toEqual([]);
        }
        finally {
            try {
                await service.dispose();
            }
            finally {
                consoleError.mockRestore();
            }
        }
    });
});

function createIdentityMessage(senderId: string, messageId: string): ALMessage {
    const value = newALUntargetedMessage(
        senderId,
        newALRoute('test.identity', 'context-1', messageId),
        'test.identity.v1',
        { value: messageId }
    );
    return { ...value, id: { ...value.id, msgId: messageId } };
}
