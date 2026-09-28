import assert from 'node:assert/strict';

import type { ClientAuthorisedWsSessionConnectAppInboxPayload } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-contracts.ts';
import type { LiveWsNotice } from '@shared-server/rallar-system/queue-pubsub/live-ws-notice.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { TestWebSocket } from '../../../../packages/tests/shared/websocket/test-web-socket.ts';
import { rememberAuthorisedWsConnection } from '../../src/runtime/rtc-topology/authorised-ws-connection-registry.ts';
import {
    filterEligibleDurableWsSessionIds,
    filterEligibleLiveWsSessionIds
} from '../../src/services/filter-eligible-live-ws-session-ids.ts';

const scope = { applicationId: 'app', workspaceId: 'workspace' };
const groupRef = { ...scope, groupId: 'room' };

function notice(
    audience: Extract<LiveWsNotice, { delivery: 'inline'; }>['audience']
): Extract<LiveWsNotice, { delivery: 'inline'; }> {
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
    const socket = new TestWebSocket('ws://eligibility');
    socket.open();
    const context = new ConnectionContext({
        id: sessionId,
        socket,
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
    const unregistered = new TestWebSocket('ws://unregistered');
    unregistered.open();
    server.connections.set(
        'unregistered',
        new ConnectionContext({
            id: 'unregistered',
            socket: unregistered,
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

Deno.test('durable unicast requires valid captured scope and current authenticated generation', () => {
    const server = new JsonWebSocketServer();
    addConnection(server, 'unicast-eligible', { scope });
    addConnection(server, 'unicast-other-app', { scope: { ...scope, applicationId: 'other' } });
    addConnection(server, 'unicast-other-workspace', { scope: { ...scope, workspaceId: 'other' } });
    addConnection(server, 'unicast-stale', { scope, registeredGenerationId: 'older-generation' });
    const message: ALMessage = {
        ...notice({ mode: 'room', groupRef, recipientSessionIds: [] }).message,
        targets: { mode: 'unicast', toPeerId: 'unicast-eligible' }
    };
    const input = {
        socketServer: server,
        message,
        candidateSessionIds: ['unicast-eligible', 'unicast-other-app', 'unicast-other-workspace', 'unicast-stale', 'absent', 'unicast-eligible'],
        recipientScope: scope,
        nowMs: 1
    };
    assert.deepEqual(filterEligibleDurableWsSessionIds(input), ['unicast-eligible']);
    assert.deepEqual(filterEligibleDurableWsSessionIds({ ...input, recipientScope: undefined }), []);
    assert.deepEqual(filterEligibleDurableWsSessionIds({ ...input, recipientScope: { ...scope, applicationId: '' } }), []);
    assert.deepEqual(filterEligibleDurableWsSessionIds({ ...input, nowMs: 1_800_000_000_000 }), []);

    addConnection(server, 'unicast-eligible', { scope: { ...scope, workspaceId: 'reconnected-elsewhere' }, socketGenerationId: 'replacement' });
    assert.deepEqual(filterEligibleDurableWsSessionIds(input), []);
});

Deno.test('verified principal broadcasts keep scoped co-group sockets while broad durable broadcasts stay excluded', () => {
    const server = new JsonWebSocketServer();
    addConnection(server, 'co-group-recipient', { scope, principalId: 'bob' });
    addConnection(server, 'wrong-workspace', { scope: { ...scope, workspaceId: 'other' }, principalId: 'bob' });
    const principal = notice({ mode: 'principal', principalRef: { ...scope, principalId: 'alice' }, recipientSessionIds: ['co-group-recipient'] });
    const broad = notice({ mode: 'broad', targetMode: 'all' });
    const input = {
        socketServer: server,
        candidateSessionIds: ['co-group-recipient', 'wrong-workspace'],
        recipientScope: scope,
        nowMs: 1
    };
    assert.deepEqual(filterEligibleDurableWsSessionIds({ ...input, message: principal.message }), ['co-group-recipient']);
    assert.deepEqual(
        filterEligibleDurableWsSessionIds({
            ...input,
            message: principal.message,
            recipientScope: { ...scope, workspaceId: 'other' }
        }),
        []
    );
    assert.deepEqual(filterEligibleDurableWsSessionIds({ ...input, message: broad.message }), []);
});

Deno.test('durable captured audience excludes a reconnected same-ID socket in another scope', () => {
    const server = new JsonWebSocketServer();
    addConnection(server, 'captured-eligible', { scope });
    addConnection(server, 'captured-stale', { scope, registeredGenerationId: 'older-generation' });
    const room = notice({ mode: 'room', groupRef, recipientSessionIds: ['captured-eligible', 'captured-stale'] });

    assert.deepEqual(
        filterEligibleDurableWsSessionIds({
            socketServer: server,
            candidateSessionIds: ['captured-eligible', 'captured-stale'],
            message: room.message,
            recipientScope: scope,
            nowMs: 1
        }),
        ['captured-eligible']
    );

    for (const recipientScope of [undefined, { ...scope, workspaceId: 'other' }]) {
        assert.deepEqual(
            filterEligibleDurableWsSessionIds({
                socketServer: server,
                candidateSessionIds: ['captured-eligible'],
                message: room.message,
                recipientScope,
                nowMs: 1
            }),
            []
        );
    }

    addConnection(server, 'captured-eligible', {
        scope: { applicationId: 'other', workspaceId: 'workspace' },
        socketGenerationId: 'replacement'
    });
    assert.deepEqual(
        filterEligibleDurableWsSessionIds({
            socketServer: server,
            candidateSessionIds: ['captured-eligible'],
            message: room.message,
            recipientScope: scope,
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
