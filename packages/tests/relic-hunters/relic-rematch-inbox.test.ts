import { createRelicGame, RELIC_PROTOCOL_VERSION, toRelicRoundTrackKey, type RelicGameState } from '@relic-hunters/mod.ts';
import { readRallarGameParticipants } from '@shared/rallar-game/read-rallar-game-participants.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { describe, expect, it } from 'vitest';
import { createAppInboxTestResilience } from '../shared-server/rallar-system/app-inbox/test-support/app-inbox-resource-fixtures.ts';
import { connectGameSession } from './relic-game-database-fixture.ts';
import { createInboxFixture } from './relic-game-inbox-fixture.ts';

describe('Relic rematch AppInbox replay', () => {
    it('replays readiness and start without regenerating a game or accepting changed intent', async () => {
        const fixture = await createInboxFixture();
        try {
            await connectGameSession(fixture, fixture.owner);
            const completed: RelicGameState = {
                ...createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs),
                phase: 'finished',
                adminPlayerId: fixture.owner.sessionId,
                winnerIds: [fixture.owner.sessionId],
                players: [{
                    playerId: fixture.owner.sessionId,
                    username: fixture.owner.username,
                    characterId: 'kael-ironstride',
                    roomId: 'exit',
                    health: 3,
                    escaped: true,
                    defeated: false,
                    score: 5,
                    relicIds: []
                }]
            };
            const ensure = await fixture.inbox.enqueue(fixture.command, async () => completed);
            await fixture.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            await fixture.inbox.wait(ensure);
            const group = await fixture.repository.readSnapshotWithAuthorityGuard(fixture.ref);
            const participant = readRallarGameParticipants(group?.snapshot, fixture.nowEpochMs)[0];
            const ready = {
                ...fixture.command,
                operation: 'command' as const,
                requestId: 'ready-owner',
                move: {
                    protocolVersion: RELIC_PROTOCOL_VERSION,
                    gameId: fixture.ref.groupId,
                    username: fixture.owner.username,
                    kind: 'set-rematch-ready' as const,
                    ready: true,
                    participationKey: participant.participationKey,
                    completedGameId: toRelicRoundTrackKey(completed),
                    settingsKey: 'round-limit:60000:0',
                    characterId: 'kael-ironstride' as const
                }
            };
            const noProposal = async (): Promise<RelicGameState> => {
                throw new Error('Readiness must not request a new expedition');
            };
            const acceptedReady = await fixture.inbox.enqueue(ready, noProposal);
            await fixture.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect(await fixture.inbox.wait(acceptedReady)).toEqual({ status: 'applied', gameId: fixture.ref.groupId });
            const savedReady = (await fixture.data.read(fixture.ref))[0].entry;
            const readyReplay = await fixture.inbox.enqueue(ready, noProposal);
            expect(await fixture.inbox.wait(readyReplay)).toEqual({ status: 'applied', gameId: fixture.ref.groupId });
            expect((await fixture.data.read(fixture.ref))[0].entry).toEqual(savedReady);
            await expect(fixture.inbox.enqueue({ ...ready, move: { ...ready.move, ready: false } }, noProposal))
                .rejects.toMatchObject({ failure: { status: 409 } });
            const start = {
                ...ready,
                requestId: 'start-owner',
                move: {
                    protocolVersion: RELIC_PROTOCOL_VERSION,
                    gameId: fixture.ref.groupId,
                    username: fixture.owner.username,
                    kind: 'start-rematch' as const,
                    completedGameId: ready.move.completedGameId,
                    settingsKey: ready.move.settingsKey
                }
            };
            let proposals = 0;
            const proposal = async () => {
                proposals++;
                return createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs + 1);
            };
            const acceptedStart = await fixture.inbox.enqueue(start, proposal);
            await fixture.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect(await fixture.inbox.wait(acceptedStart)).toEqual({ status: 'applied', gameId: fixture.ref.groupId });
            const savedStart = (await fixture.data.read(fixture.ref))[0].entry;
            const replay = await fixture.inbox.enqueue(start, proposal);
            expect(await fixture.inbox.wait(replay)).toEqual({ status: 'applied', gameId: fixture.ref.groupId });
            expect(proposals).toBe(1);
            expect((await fixture.data.read(fixture.ref))[0].entry).toEqual(savedStart);
            const snapshot = await fixture.service.readCurrentSnapshot(fixture.command, 'default-qbox-server');
            expect(snapshot?.phase).toBe('planning');
            expect(snapshot?.players.map((hunter) => [hunter.playerId, hunter.score])).toEqual([[fixture.owner.sessionId, 0]]);
        }
        finally {
            await fixture.storage.close();
        }
    });
});
