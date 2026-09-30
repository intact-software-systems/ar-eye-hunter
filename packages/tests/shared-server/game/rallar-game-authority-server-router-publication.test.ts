import { describe, expect, it, onTestFinished } from 'vitest';

import { installRallarGameAuthorityServer } from '@shared-server/game/install-rallar-game-authority-server.ts';
import type {
    JsonWireObject,
    JsonWireValue
} from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type { LiveWsNotice } from '@shared-server/rallar-system/queue-pubsub/live-ws-notice.ts';
import { createServerPublishRoomAudienceReader } from '@shared-server/rallar-system/websocket/read-server-publish-room-audience.ts';
import { RallarServerWsRouter } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts';
import { newALBroadcastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import {
    createRallarGameAuthorityEnvelope,
    type RallarGameAuthorityRef
} from '@shared/rallar-game/mod.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import {
    ConnectionContext,
    JsonWebSocketServer
} from '@shared/websocket/json-web-socket-server.ts';

import { TestWebSocket } from '../../shared/websocket/test-web-socket.ts';
import { createGroupSnapshot } from '../rallar-system/group-state/snapshot/group-state-snapshot-test-fixtures.ts';

interface Command {
    readonly action: string;
}

interface Snapshot {
    readonly tick: number;
}

interface Event {
    readonly kind: string;
}

interface GameRouterFixture {
    readonly router: RallarServerWsRouter;
    readonly roomRef: GroupRef;
    readonly players: Readonly<Record<'player-a' | 'player-b', TestWebSocket>>;
    readonly notices: readonly LiveWsNotice[];
}

const PROTOCOL = 'test.authority.v1';
const TOPIC_ID = 'room.game';
const AUTHORITY: RallarGameAuthorityRef = { kind: 'server', id: 'game-server', epoch: 1 };

describe('Rallar Game authority server through the real WS router', () => {
    it('sends default snapshot and event publications live to the room', async () => {
        const fixture = createGameRouterFixture();
        const server = installRallarGameAuthorityServer<Command, Snapshot, Event>({
            rallar: { ws: fixture.router },
            protocol: PROTOCOL,
            topicId: TOPIC_ID,
            authority: AUTHORITY,
            decodeCommand: toCommand,
            nowEpochMs: () => Date.now(),
            handleCommand: async () => ({ status: 'accepted' })
        });

        const snapshot = await server.publishSnapshot({
            roomId: fixture.roomRef.groupId,
            roomRef: fixture.roomRef,
            snapshot: { tick: 7 }
        });
        const event = await server.publishEvent({
            roomId: fixture.roomRef.groupId,
            roomRef: fixture.roomRef,
            event: { kind: 'opened' }
        });

        expect(snapshot).toMatchObject({
            status: 'sent',
            raw: { fanout: 'live-only', status: 'sent-live' }
        });
        expect(event).toMatchObject({
            status: 'sent',
            raw: { fanout: 'live-only', status: 'sent-live' }
        });
        expect(server.status()).toMatchObject({
            publishedSnapshotCount: 1,
            publishedEventCount: 1
        });
        for (const player of Object.values(fixture.players)) {
            expect(readReceivedTypeIds(player)).toEqual([
                'room.game.snapshot.v1',
                'room.game.event.v1'
            ]);
        }
    });

    it('publishes default snapshot and event publications as one cluster notice each', async () => {
        const fixture = createGameRouterFixture(true);
        const server = installRallarGameAuthorityServer<Command, Snapshot, Event>({
            rallar: { ws: fixture.router },
            protocol: PROTOCOL,
            topicId: TOPIC_ID,
            authority: AUTHORITY,
            decodeCommand: toCommand,
            nowEpochMs: () => Date.now(),
            handleCommand: async () => ({ status: 'accepted' })
        });

        const snapshot = await server.publishSnapshot({
            roomId: fixture.roomRef.groupId,
            roomRef: fixture.roomRef,
            snapshot: { tick: 9 }
        });
        const event = await server.publishEvent({
            roomId: fixture.roomRef.groupId,
            roomRef: fixture.roomRef,
            event: { kind: 'clustered' }
        });

        // Pins the router result; the game status of a cluster notice belongs to the status mapping.
        expect(snapshot.raw).toMatchObject({ fanout: 'live-only', status: 'cluster-published' });
        expect(event.raw).toMatchObject({ fanout: 'live-only', status: 'cluster-published' });
        expect(server.status()).toMatchObject({
            publishedSnapshotCount: 1,
            publishedEventCount: 1
        });
        expect(
            fixture.notices.map((notice) => notice.delivery === 'inline' ? notice.message.payload.typeId : undefined)
        )
            .toEqual(['room.game.snapshot.v1', 'room.game.event.v1']);
        for (const player of Object.values(fixture.players)) {
            expect(readReceivedTypeIds(player)).toEqual([
                'room.game.snapshot.v1',
                'room.game.event.v1'
            ]);
        }
    });

    it('answers a routed command with a live command result, snapshot and event', async () => {
        const fixture = createGameRouterFixture();
        installRallarGameAuthorityServer<Command, Snapshot, Event>({
            rallar: { ws: fixture.router },
            protocol: PROTOCOL,
            topicId: TOPIC_ID,
            authority: AUTHORITY,
            decodeCommand: toCommand,
            nowEpochMs: () => Date.now(),
            handleCommand: async () => ({
                status: 'accepted',
                snapshot: { tick: 8 },
                events: [{ kind: 'moved' }]
            })
        });
        const command = createRallarGameAuthorityEnvelope({
            protocol: PROTOCOL,
            kind: 'command',
            roomId: fixture.roomRef.groupId,
            senderId: 'player-a',
            seq: 1,
            sentAtEpochMs: Date.now(),
            authority: AUTHORITY,
            payload: { action: 'move' }
        });
        const message = newALBroadcastMessage(
            'player-a',
            newALRoute(TOPIC_ID, fixture.roomRef.groupId, 'command-1'),
            'room',
            'room.game.command.v1',
            command,
            { groupRef: fixture.roomRef, exceptPeerIds: ['player-a'] }
        );

        await fixture.router.route(message, {
            kind: 'ws-client',
            peerId: 'player-a',
            authenticatedScope: toScope(fixture.roomRef),
            groupRecipientPeerIds: ['player-b']
        });

        expect(readReceivedTypeIds(fixture.players['player-a'])).toEqual([
            'room.game.command-result.v1',
            'room.game.snapshot.v1',
            'room.game.event.v1'
        ]);
        expect(readReceivedTypeIds(fixture.players['player-b'])).toEqual([
            'room.game.snapshot.v1',
            'room.game.event.v1'
        ]);
    });
});

function createGameRouterFixture(cluster = false): GameRouterFixture {
    const snapshot = createGroupSnapshot(2, ['player-a', 'player-b']);
    const roomRef: GroupRef = {
        applicationId: snapshot.group.applicationId,
        workspaceId: snapshot.group.workspaceId,
        groupId: snapshot.group.groupId
    };
    const socket = new JsonWebSocketServer();
    const players = {
        'player-a': new TestWebSocket('ws://player-a'),
        'player-b': new TestWebSocket('ws://player-b')
    };
    for (const [sessionId, player] of Object.entries(players)) {
        player.open();
        socket.addConnection(new ConnectionContext({ id: sessionId, socket: player }));
    }
    const service = createDefaultWsQueueBoxServerService({
        outbox: new InMemoryQueueBox(new Map()),
        socket,
        name: 'server-1',
        readAuthenticatedConnectionScope: (connection) =>
            socket.connections.get(connection.id) === connection
                ? { scope: toScope(roomRef), expiresAtEpochMs: Number.MAX_SAFE_INTEGER }
                : undefined,
        targetResolver: {
            resolvePeerIdForConnection: (connectionId) => connectionId,
            resolvePeerRecipients: (peerId) => [{ peerId, connectionId: peerId }],
            resolveBroadcastRecipients: () => Object.keys(players).map((peerId) => ({ peerId, connectionId: peerId }))
        }
    });
    onTestFinished(() => service.dispose());
    const notices: LiveWsNotice[] = [];
    const router = new RallarServerWsRouter(service, {
        livePublication: cluster
            ? {
                transport: {
                    publish: async (notice) => {
                        notices.push(notice);
                    },
                    subscribe: async () => {}
                },
                channel: 'ws-channel',
                publisherId: 'server-a'
            }
            : undefined,
        authorizeRoomMessage: ({ message }) =>
            message.targets === undefined ? false : {
                authorized: true,
                audience: {
                    targets: message.targets,
                    sessions: snapshot.activeSessions,
                    snapshotVersion: 2
                }
            },
        readServerPublishAudience: createServerPublishRoomAudienceReader({
            readGroupSnapshot: async () => snapshot,
            nowEpochMs: () => Date.now()
        })
    });
    return { router, roomRef, players, notices };
}

function toCommand(value: JsonWireValue): Command {
    if (!isJsonWireObject(value) || typeof value.action !== 'string') {
        throw new Error('Game command action must be a string');
    }
    return { action: value.action };
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toScope(
    roomRef: GroupRef
): { readonly applicationId: string; readonly workspaceId: string; } {
    return { applicationId: roomRef.applicationId, workspaceId: roomRef.workspaceId };
}

function readReceivedTypeIds(player: TestWebSocket): readonly string[] {
    return player.sent.map((sent) => decodePersistedALMessage(sent).payload.typeId);
}
