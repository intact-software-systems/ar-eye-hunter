import assert from 'node:assert/strict';

import type { ClientAuthorisedWsSessionConnectAppInboxPayload } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-contracts.ts';
import type { LiveWsNotice } from '@shared-server/rallar-system/queue-pubsub/live-ws-notice.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { rememberAuthorisedWsConnection } from '../../src/runtime/rtc-topology/authorised-ws-connection-registry.ts';
import { filterEligibleLiveWsSessionIds } from '../../src/services/filter-eligible-live-ws-session-ids.ts';

const scope = { applicationId: 'app', workspaceId: 'workspace' };
const groupRef = { ...scope, groupId: 'room' };

function notice(audience: Extract<LiveWsNotice, { delivery: 'inline'; }>['audience']): LiveWsNotice {
    const common = {
        kind: 'live-ws' as const,
        version: 1 as const,
        channel: 'ws-channel',
        publisherId: 'remote',
        expiresAtMs: 1_800_000_000_000,
        delivery: 'inline' as const
    };
    const message: ALMessage = {
        id: { v: 2, msgId: 'message', ts: 1, senderId: 'sender' },
        route: { topicId: 'room.match', resourceId: 'room', contextId: 'room' },
        targets: audience.mode === 'broad'
            ? { mode: 'broadcast', scope: audience.targetMode }
            : audience.mode === 'principal'
            ? { mode: 'broadcast', scope: 'principal', principalRef: audience.principalRef }
            : { mode: 'multicast', groupRef },
        payload: { typeId: 'room.match', resource: '{}' }
    };
    return audience.mode === 'broad'
        ? { ...common, audience, message }
        : { ...common, scope, audience, message };
}

interface AddConnectionInput {
    readonly scope: typeof scope;
    readonly principalId?: string;
    readonly socketGenerationId?: string;
    readonly registeredGenerationId?: string;
}

function addConnection(
    server: JsonWebSocketServer,
    sessionId: string,
    input: AddConnectionInput
): void {
    const socketGenerationId = input.socketGenerationId ?? 'generation';
    const registeredGenerationId = input.registeredGenerationId ?? socketGenerationId;
    const context = new ConnectionContext({
        id: sessionId,
        socket: { readyState: WebSocket.OPEN } as WebSocket,
        generationId: socketGenerationId,
        generationStartedAtEpochMs: 100
    });
    server.connections.set(sessionId, context);
    const facts: ClientAuthorisedWsSessionConnectAppInboxPayload = {
        authSession: {
            clientId: 'client',
            username: 'user',
            sessionId,
            issuedAtEpochMs: 1,
            expiresAtEpochMs: 1_800_000_000_000
        },
        generationId: registeredGenerationId,
        generationStartedAtEpochMs: 100,
        scope: input.scope,
        principalId: input.principalId ?? 'principal',
        clientInstanceId: 'instance',
        displayName: 'User',
        userAgent: null,
        platform: 'web',
        capabilities: [],
        expiresAtEpochMs: 1_800_000_000_000
    };
    rememberAuthorisedWsConnection(sessionId, registeredGenerationId, facts);
}

Deno.test('frozen room delivery keeps only currently open authenticated sockets in the scoped audience', () => {
    const server = new JsonWebSocketServer();
    addConnection(server, 'eligible', { scope });
    addConnection(server, 'wrong-app', { scope: { applicationId: 'other', workspaceId: 'workspace' } });
    addConnection(server, 'wrong-workspace', { scope: { applicationId: 'app', workspaceId: 'other' } });
    addConnection(server, 'stale-generation', { scope, registeredGenerationId: 'older-generation' });
    server.connections.set(
        'unregistered',
        new ConnectionContext({
            id: 'unregistered',
            socket: { readyState: WebSocket.OPEN } as WebSocket,
            generationId: 'generation',
            generationStartedAtEpochMs: 100
        })
    );
    const room = notice({
        mode: 'room',
        groupRef,
        recipientSessionIds: ['eligible', 'wrong-app', 'wrong-workspace', 'stale-generation', 'unregistered']
    });

    assert.deepEqual(
        filterEligibleLiveWsSessionIds({
            socketServer: server,
            candidateSessionIds: ['eligible', 'wrong-app', 'wrong-workspace', 'stale-generation', 'unregistered'],
            notice: room,
            nowMs: 1
        }),
        ['eligible']
    );

    addConnection(server, 'eligible', {
        scope: { applicationId: 'other', workspaceId: 'workspace' },
        socketGenerationId: 'replacement'
    });
    assert.deepEqual(
        filterEligibleLiveWsSessionIds({
            socketServer: server,
            candidateSessionIds: ['eligible'],
            notice: room,
            nowMs: 1
        }),
        []
    );
});

Deno.test('principal and broad notices use current authenticated eligibility', () => {
    const server = new JsonWebSocketServer();
    addConnection(server, 'principal-a', { scope, principalId: 'principal-a' });
    addConnection(server, 'principal-b', { scope, principalId: 'principal-b' });
    const principal = notice({
        mode: 'principal',
        principalRef: { ...scope, principalId: 'principal-a' },
        recipientSessionIds: ['principal-a', 'principal-b']
    });
    assert.deepEqual(
        filterEligibleLiveWsSessionIds({
            socketServer: server,
            candidateSessionIds: ['principal-a', 'principal-b'],
            notice: principal,
            nowMs: 1
        }),
        ['principal-a']
    );

    const broad = notice({ mode: 'broad', targetMode: 'all' });
    assert.equal(Object.hasOwn(broad, 'scope'), false);
    addConnection(server, 'just-opened', {
        scope: { applicationId: 'another', workspaceId: 'workspace' },
        principalId: 'principal-c'
    });
    assert.deepEqual(
        filterEligibleLiveWsSessionIds({
            socketServer: server,
            candidateSessionIds: ['just-opened', 'not-open'],
            notice: broad,
            nowMs: 1
        }),
        ['just-opened']
    );
});
