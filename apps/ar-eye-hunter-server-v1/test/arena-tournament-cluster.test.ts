import { test } from 'bun:test';

import { decodeArenaTournamentSnapshot, type ArenaTournamentSnapshot } from '@ar-eye-hunter/arena-tournament-snapshot.ts';
import { ARENA_TOURNAMENT_SNAPSHOT_SENDER, decodeArenaTournamentFrame, isArenaTournamentFrameMessage } from '@ar-eye-hunter/arena-tournament-stream.ts';
import { ARENA_TOURNAMENT_FINISH_TOPIC } from '@ar-eye-hunter/server/arena-tournament-deadline.ts';
import { ArenaTournamentPublication, installArenaTournamentFinishPublication } from '@ar-eye-hunter/server/arena-tournament-publication.ts';
import { publishArenaTournamentSnapshot } from '@ar-eye-hunter/server/arena-tournament-publication.ts';
import { ArenaTournamentSnapshotReader } from '@ar-eye-hunter/server/arena-tournament-room.ts';
import { AR_EYE_TOURNAMENT_RULES_ID, createTournamentArena } from '@ar-eye-hunter/tournament-arena.ts';
import { createServerPublishRoomAudienceReader } from '@shared-server/rallar-system/websocket/read-server-publish-room-audience.ts';
import { WsGrantedTopicSet } from '@shared-server/rallar-system/websocket/room-publication/ws-granted-topic-set.ts';
import { RallarServerWsRouter } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts';
import { decodeALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { createDefaultBackgroundTimers } from '@shared/resilience/timers.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    commitArenaTournamentCommand,
    createArenaTournamentSqlFixture,
    type ArenaTournamentSqlFixture
} from '../../../packages/tests/ar-eye-hunter/server/arena-tournament-sql-fixture.ts';
import { createSqlServerAppInbox } from '../../../packages/tests/shared-server/rallar-server/create-test-server-app-inbox.ts';
import { createAppInboxTestResilience } from '../../../packages/tests/shared-server/rallar-system/app-inbox/test-support/app-inbox-resource-fixtures.ts';
import { createGroupSnapshot } from '../../../packages/tests/shared-server/rallar-system/group-state/snapshot/group-state-snapshot-test-fixtures.ts';
import { ArenaTournamentClusterNode } from './arena-tournament-cluster-node.ts';

const scope = { applicationId: 'ar-eye-hunter', workspaceId: 'default' };
const roomRef = { ...scope, groupId: 'native-cluster-room' };
const sessionIds = ['local-player', 'remote-spectator', 'replaced'];
const databaseUrl = process.env['DATABASE_URL'];

test.skipIf(process.env['RALLAR_POSTGRES_INTEGRATION'] !== '1')(
    'a mixed remote node delivers one complete oversized AR frame to the admitted player and spectator generations through real PostgreSQL',
    async () => {
        assert.ok(databaseUrl, 'Set DATABASE_URL to an isolated test database');
        const channel = 'frame_' + crypto.randomUUID().replaceAll('-', '');
        const producer = new ArenaTournamentClusterNode({ id: 'producer', databaseUrl, channel, scope });
        const mixed = new ArenaTournamentClusterNode({ id: 'receiver', databaseUrl, channel, scope });
        try {
            await Promise.all([producer.subscribe(), mixed.subscribe()]);
            const [player, spectator, replaced, outsider] = await Promise.all([
                producer.connect(sessionIds[0], 'ws-generation-local-player'),
                mixed.connect(sessionIds[1], 'ws-generation-remote-spectator'),
                mixed.connect(sessionIds[2], 'new-not-in-room'),
                mixed.connect('outsider', 'outsider-generation')
            ]);
            const router = clusterPublisher(producer);
            const snapshot = oversizedCheckpoint();
            await publishArenaTournamentSnapshot(router, snapshot);
            await waitForFrames(player, spectator);
            await Promise.all([player, spectator].map(async ([text]) => {
                const message = decodeALMessageValue(JSON.parse(text)).right!;
                assert.ok(isArenaTournamentFrameMessage(message, snapshot.binding));
                assert.deepEqual(
                    await decodeArenaTournamentFrame(JSON.parse(message.payload.resource)),
                    decodeArenaTournamentSnapshot(JSON.parse(JSON.stringify(snapshot)))
                );
            }));
            assert.deepEqual([player.length, spectator.length, replaced.length, outsider.length], [1, 1, 0, 0]);
            assert.ok(producer.physicalBytes.length >= 2 && producer.physicalBytes.every((byteLength) => byteLength < 8000));
            console.log(
                JSON.stringify({
                    rawSnapshotBytes: new TextEncoder().encode(JSON.stringify(snapshot)).length,
                    websocketBytes: new TextEncoder().encode(player[0]).length,
                    postgresNotificationBytes: producer.physicalBytes,
                    localPlayer: player.length,
                    remoteSpectator: spectator.length,
                    replaced: replaced.length,
                    outsider: outsider.length
                })
            );
        }
        finally {
            await Promise.all([producer.stop(), mixed.stop()]);
        }
    }
);

function clusterPublisher(node: ArenaTournamentClusterNode): RallarServerWsRouter {
    const base = createGroupSnapshot(2, sessionIds);
    const snapshot: GroupSnapshot = {
        ...base,
        group: { ...base.group, ...roomRef },
        members: base.members.map((member) => ({ ...member, ...roomRef, role: member.principalId.includes('spectator') ? 'spectator' : member.role })),
        activeSessions: base.activeSessions.map((session) => ({ ...session, ...roomRef }))
    };
    return new RallarServerWsRouter(node.service, {
        grantedTopics: new WsGrantedTopicSet(),
        livePublication: { transport: node.transport, channel: node.channel, publisherId: node.id },
        readServerPublishAudience: createServerPublishRoomAudienceReader({
            nowEpochMs: Date.now,
            readGroupSnapshot: async () => snapshot,
            readPublicationAuthority: async () => ({
                snapshot,
                subscriptions: [],
                liveSessionGenerations: {
                    'local-player': ['ws-generation-local-player'],
                    'remote-spectator': ['ws-generation-remote-spectator'],
                    replaced: ['new-not-in-room']
                }
            })
        })
    }).defineTopic({
        topicId: AppTopics.serverRoomSnapshot,
        scope: 'room',
        fanout: 'live-only',
        participation: 'server',
        serverProducerIds: [ARENA_TOURNAMENT_SNAPSHOT_SENDER]
    });
}

function oversizedCheckpoint(): ArenaTournamentSnapshot {
    const state = createTournamentArena({ gameId: 'game', principalIds: ['alice', 'bob'], startedAtEpochMs: 1000, durationMs: 60000, seed: 7 });
    // A full valid native event ring with distinct authored headlines crosses one-recipient inline capacity.
    const initial = state.arena.activeEvent;
    assert.ok(initial);
    const events = Array.from({ length: 24 }, (_, i) => ({
        ...initial,
        id: 'event-' + i,
        headline: Array.from({ length: 5 }, (_, j) => createHash('sha256').update(`${i}:${j}`).digest('hex')).join('')
    }));
    return {
        binding: {
            tournamentRef: { ...scope, tournamentId: 'cup' },
            roomRef,
            slot: 'final',
            attemptId: 'attempt',
            gameId: 'game',
            rulesId: AR_EYE_TOURNAMENT_RULES_ID,
            principalIds: ['alice', 'bob']
        },
        attemptRevision: 42,
        observedAtEpochMs: Date.now(),
        status: 'playing',
        state: { ...state, arena: { ...state.arena, events } }
    };
}

async function waitForFrames(...recipients: string[][]): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!recipients.every((frames) => frames.length > 0)) {
        if (Date.now() >= deadline) {
            throw new Error('Remote native snapshot did not arrive');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

test.skipIf(process.env['RALLAR_POSTGRES_INTEGRATION'] !== '1')(
    'a replacement finish worker sends the committed terminal snapshot to a continuously connected remote spectator',
    async () => {
        assert.ok(databaseUrl);
        const game = await createArenaTournamentSqlFixture(roomRef);
        const channel = 'finish_' + crypto.randomUUID().replaceAll('-', '');
        const remote = new ArenaTournamentClusterNode({ id: 'remote', databaseUrl, channel, scope });
        const replacement = new ArenaTournamentClusterNode({ id: 'replacement-worker', databaseUrl, channel, scope });
        try {
            await remote.subscribe();
            const frames = await remote.connect('remote-spectator', 'ws-generation-remote-spectator');
            const connection = remote.socket.connections.get('remote-spectator');
            assert.ok(connection?.isOpen);
            // No finish queue reader exists on the writer. The committed result and reminder survive its lifetime.
            await commitArenaTick(game, 'open');
            game.nowEpochMs += 60000;
            for (let index = 0; index < 60; index++) {
                await commitArenaTick(game, 'step-' + index);
            }
            const terminal = await game.snapshots.readSnapshot(roomRef, 'owner');
            assert.ok(terminal?.status === 'finished');
            assert.deepEqual(frames, []);

            await replacement.subscribe();
            const restart = createSqlServerAppInbox({ database: game.storage.sql, nowEpochMs: () => game.nowEpochMs });
            const restartedReader = new ArenaTournamentSnapshotReader(game.storage.sql, [game.dataBinding], () => game.nowEpochMs);
            const router = clusterPublisher(replacement);
            const publisher = new ArenaTournamentPublication({
                timers: createDefaultBackgroundTimers(),
                read: (ref) => restartedReader.readForPublication(ref),
                send: (current) => publishArenaTournamentSnapshot(router, current)
            });
            try {
                installArenaTournamentFinishPublication({ outbox: restart.outbox, publication: publisher, nowEpochMs: () => game.nowEpochMs });
                // The accelerated game finished 60s ahead of wall time; release just its logically due reminder.
                await game.storage.sql`update resource_inbox set next_ts = now() at time zone 'UTC' where ri_topic_id = ${ARENA_TOURNAMENT_FINISH_TOPIC}`;
                assert.equal(await restart.outbox.dequeueOutbox(OutboxQueueReader.OUTBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0)), 1);
                await waitForFrames(frames);
                const message = decodeALMessageValue(JSON.parse(frames[0])).right!;
                assert.ok(isArenaTournamentFrameMessage(message, terminal.binding));
                assert.deepEqual(
                    await decodeArenaTournamentFrame(JSON.parse(message.payload.resource)),
                    decodeArenaTournamentSnapshot(JSON.parse(JSON.stringify(terminal)))
                );
                assert.equal(frames.length, 1);
                assert.equal(remote.socket.connections.get('remote-spectator'), connection);
                assert.ok(connection.isOpen);
            }
            finally {
                await publisher.stop();
            }
        }
        finally {
            await Promise.all([replacement.stop(), remote.stop(), game.storage.close()]);
        }
    }
);

async function commitArenaTick(game: ArenaTournamentSqlFixture, requestId: string): Promise<void> {
    await commitArenaTournamentCommand(game, { kind: 'tick', roomRef: game.binding.roomRef, requestId, actor: null, input: null, capturedAtEpochMs: 0 });
}
