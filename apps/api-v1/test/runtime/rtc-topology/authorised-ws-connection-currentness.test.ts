import assert from 'node:assert/strict';

import type { ClientAuthorisedWsSessionConnectAppInboxPayload } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-contracts.ts';
import type { ClientSession } from '@shared/api/client-types.ts';
import { ConnectionContext } from '@shared/websocket/json-web-socket-server.ts';

import { TestWebSocket } from '../../../../../packages/tests/shared/websocket/test-web-socket.ts';
import {
    readAuthorisedWsConnectionCurrentness,
    releaseAuthorisedWsCloseFacts,
    rememberAuthorisedWsConnection
} from '../../../src/runtime/rtc-topology/authorised-ws-connection-registry.ts';
import { createClientSnapshot, TEST_SCOPE } from '../../client-state/client-state-route-test-runtime.ts';

Deno.test('a socket is current only while its session entry names its own connection generation', async () => {
    const connection = rememberConnection('session-1', 'generation-old');
    const snapshotNaming = (generationId: string) => async () => ({
        ...createClientSnapshot('alice'),
        activeSessions: [session('session-1', generationId)]
    });
    try {
        assert.equal(await readAuthorisedWsConnectionCurrentness(connection, snapshotNaming('generation-old')), true);
        // The session reconnected elsewhere: the snapshot names the newer generation.
        assert.equal(await readAuthorisedWsConnectionCurrentness(connection, snapshotNaming('generation-new')), false);
        assert.equal(await readAuthorisedWsConnectionCurrentness(connection, async () => undefined), false);
    }
    finally {
        releaseAuthorisedWsCloseFacts({
            sessionId: 'session-1',
            generationId: 'generation-old',
            generationStartedAtEpochMs: 100,
            disconnectedAtEpochMs: 200,
            reason: 'test'
        });
    }
});

Deno.test('a socket without authorised connection facts is never current', async () => {
    const socket = new TestWebSocket('ws://unregistered');
    socket.open();
    const connection = new ConnectionContext({ id: 'unregistered', socket, generationId: 'generation' });

    assert.equal(
        await readAuthorisedWsConnectionCurrentness(connection, async () => ({
            ...createClientSnapshot('alice'),
            activeSessions: [session('unregistered', 'generation')]
        })),
        false
    );
});

function rememberConnection(sessionId: string, generationId: string): ConnectionContext {
    const socket = new TestWebSocket('ws://currentness');
    socket.open();
    const facts: ClientAuthorisedWsSessionConnectAppInboxPayload = {
        authSession: {
            clientId: 'client',
            username: 'alice',
            sessionId,
            issuedAtEpochMs: 1,
            expiresAtEpochMs: 1_800_000_000_000
        },
        generationId,
        generationStartedAtEpochMs: 100,
        scope: TEST_SCOPE,
        principalId: 'alice',
        clientInstanceId: 'instance-1',
        displayName: 'Alice',
        userAgent: null,
        platform: 'web',
        capabilities: [],
        expiresAtEpochMs: 1_800_000_000_000
    };
    rememberAuthorisedWsConnection(sessionId, generationId, facts);
    return new ConnectionContext({ id: sessionId, socket, generationId, generationStartedAtEpochMs: 100 });
}

function session(sessionId: string, generationId: string): ClientSession {
    return {
        ...TEST_SCOPE,
        principalId: 'alice',
        clientInstanceId: 'instance-1',
        sessionId,
        generationId,
        generationVersion: 1,
        presenceState: 'online',
        transport: 'ws',
        connectionId: null,
        authenticatedAtEpochMs: 1,
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: 1_800_000_000_000,
        status: 'active',
        disconnectedAtEpochMs: null,
        disconnectReason: null
    };
}
