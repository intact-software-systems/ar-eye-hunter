import assert from 'node:assert/strict';

import type { ClientSession } from '@shared/api/client-types.ts';
import { createApiV1WsLivePublication } from '../../src/composition/create-api-v1-ws-live-publication.ts';
import { createClientSnapshot, TEST_SCOPE } from '../client-state/client-state-route-test-runtime.ts';

Deno.test('Postgres publisher uses the shared notice channel and freezes only live principal sessions', async () => {
    const notified: object[] = [];
    const snapshot = createClientSnapshot('alice');
    const session: ClientSession = {
        ...TEST_SCOPE,
        principalId: 'alice',
        clientInstanceId: 'instance-1',
        sessionId: 'session-1',
        generationId: 'generation-1',
        generationVersion: 1,
        presenceState: 'online',
        transport: 'ws',
        connectionId: null,
        authenticatedAtEpochMs: 1,
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: 200,
        status: 'active',
        disconnectedAtEpochMs: null,
        disconnectReason: null
    };
    const publication = createApiV1WsLivePublication({
        mode: 'postgres',
        notification: {
            notify: async (_channel, notice) => {
                notified.push(notice);
            },
            listen: async () => {}
        },
        nowEpochMs: () => 100,
        readClientSnapshot: async () => ({
            ...snapshot,
            activeSessions: [
                session,
                { ...session, sessionId: 'expired', expiresAtEpochMs: 100 },
                { ...session, sessionId: 'other-workspace', workspaceId: 'other' }
            ]
        })
    });
    assert.ok(publication);
    assert.deepEqual(await publication.readPrincipalSessionIds?.({ ...TEST_SCOPE, principalId: 'alice' }), ['session-1']);
    assert.deepEqual(await publication.readPrincipalSessionIds?.({ ...TEST_SCOPE, principalId: 'bob' }), undefined);
    await publication.transport.publish({
        kind: 'live-ws',
        version: 1,
        channel: publication.channel,
        publisherId: publication.publisherId,
        delivery: 'inbound-key',
        expiresAtMs: 200,
        audienceMode: 'broad',
        targetMode: 'all',
        inbound: { namespace: 'ws', reference: { senderId: 'server', msgId: 'message' } }
    });
    assert.equal(notified.length, 1);
});

Deno.test('local and disabled API modes do not claim a cluster publisher', () => {
    for (const mode of ['local', 'disabled'] as const) {
        assert.equal(
            createApiV1WsLivePublication({
                mode,
                notification: null,
                nowEpochMs: () => 100,
                readClientSnapshot: async () => undefined
            }),
            undefined
        );
    }
});
