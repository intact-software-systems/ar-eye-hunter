import { Temporal } from '@js-temporal/polyfill';
import { createRelicGame } from '@relic-hunters/mod.ts';
import { decodeRelicGameCommand } from '@relic-hunters/server/relic-game-mutation-service.ts';
import type { RelicGameMutationService } from '@relic-hunters/server/relic-game-mutation-service.ts';
import { installRelicTournamentClock } from '@relic-hunters/server/relic-tournament-deadline.ts';
import { advanceRelicTournamentClock, startRelicTournament } from '@relic-hunters/src/tournament-expedition.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import { describe, expect, it } from 'vitest';
import { createAppInboxTestResilience } from '../shared-server/rallar-system/app-inbox/test-support/app-inbox-resource-fixtures.ts';
import { createRelicGameInboxFixture } from './relic-game-inbox-fixture.ts';
import { createTournamentGameFixture } from './relic-tournament-database-fixture.ts';

const start = 1700000000000;
const players = ['alice', 'bob'] as const;

describe('Native Relic tournament clock', () => {
    it('starts the two checked-in accounts using native admission and frozen rules', () => {
        const state = startRelicTournament('match-room', players, start);
        expect(state.phase).toBe('planning');
        expect(state.players.map((player) => player.playerId)).toEqual(players);
        expect(state.roundTimeLimitMs).toBe(60000);
        expect(state.maxRounds).toBe(10);
    });
    it('resolves only the due round and leaves stale deliveries harmless', () => {
        const state = startRelicTournament('match-room', players, start);
        const clock = { phase: 'planning' as const, round: 1, dueAtEpochMs: start + 60000 };
        expect(advanceRelicTournamentClock(state, clock, start + 59999)).toBe(state);
        const review = advanceRelicTournamentClock(state, clock, clock.dueAtEpochMs);
        expect(review.phase).toBe('review');
        expect(review.pendingActions).toEqual([]);
        expect(advanceRelicTournamentClock(review, clock, start + 70000)).toBe(review);
    });
    it('finishes a finite native expedition without either browser remaining connected', () => {
        let state = startRelicTournament('match-room', players, start);
        for (let round = 1; round <= 10; round++) {
            const planning = { phase: 'planning' as const, round, dueAtEpochMs: state.updatedAtEpochMs + 60000 };
            state = advanceRelicTournamentClock(state, planning, planning.dueAtEpochMs);
            const review = { phase: 'review' as const, round, dueAtEpochMs: state.updatedAtEpochMs + 10000 };
            expect(advanceRelicTournamentClock(state, review, review.dueAtEpochMs - 1)).toBe(state);
            state = advanceRelicTournamentClock(state, review, review.dueAtEpochMs);
            if (state.phase === 'finished') {
                break;
            }
        }
        expect(state.phase).toBe('finished');
        expect(state.players).toHaveLength(2);
        expect(state.players.every((player) => Number.isFinite(player.score))).toBe(true);
    });
    it('does not turn an ordinary lobby into a tournament through a round delivery', () => {
        const lobby = createRelicGame('room', 'room', start);
        expect(advanceRelicTournamentClock(lobby, { phase: 'planning', round: 1, dueAtEpochMs: start }, start)).toBe(lobby);
    });
});

describe('Relic durable tournament transitions', () => {
    it('starts and completes through the same guarded mutation service with no authenticated clock actor', async () => {
        const game = await createTournamentGameFixture();
        try {
            let due = game.nowEpochMs;
            let clock: RelicGameMutationService.ClockCommand['clock'] = { phase: 'start', round: 1, dueAtEpochMs: due };
            for (let step = 0; step < 21; step++) {
                game.nowEpochMs = due;
                const command: RelicGameMutationService.ClockCommand = {
                    operation: 'tournament-clock',
                    gameId: game.ref.groupId,
                    requestId: crypto.randomUUID(),
                    actor: null,
                    authorization: 'tournament',
                    move: null,
                    clock
                };
                const read = await game.service.read(game.service.capture(command, null, 'relic-clock'));
                const attempt = { ...read, attemptCount: 1, traceId: 'relic-clock-test' };
                const computed = game.service.compute(attempt);
                expect(computed.result.status).toBe('applied');
                expect(game.service.validate(attempt, computed)).toEqual([]);
                await game.storage.sql.begin((transaction) => game.service.write(transaction, computed));
                const snapshot = await game.service.readCurrentSnapshot(game.command, 'relic-clock');
                expect(snapshot?.players.map((player) => player.playerId)).toEqual(game.binding.principalIds);
                if (snapshot!.phase === 'finished') {
                    break;
                }
                expect(computed.outboxWrites.some((write) => write.entry.key.topicId === 'app:relic:tournament-clock')).toBe(true);
                const phase = snapshot!.phase === 'planning' ? 'planning' : 'review';
                due = snapshot!.updatedAtEpochMs + (phase === 'planning' ? 60000 : 10000);
                clock = { phase, round: snapshot!.round, dueAtEpochMs: due };
            }
            const stored = await game.tournaments.read(game.binding);
            expect(stored.attempt?.status).toBe('finished');
            expect(stored.result?.standings).toHaveLength(2);
        }
        finally {
            await game.storage.close();
        }
    }, 20000);
});

it('recovers a persisted round deadline on a cold worker and replays it without another native transition', async () => {
    const game = await createTournamentGameFixture();
    try {
        const producer = createRelicGameInboxFixture(game, {});
        const start: RelicGameMutationService.ClockCommand = {
            operation: 'tournament-clock',
            gameId: game.ref.groupId,
            requestId: 'start-after-bracket-commit',
            actor: null,
            authorization: 'tournament',
            move: null,
            clock: { phase: 'start', round: 1, dueAtEpochMs: game.nowEpochMs }
        };
        await producer.inbox.enqueueTournamentClock(start, 'clock-start-test');
        await producer.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
        const before = (await game.data.read(game.ref))[0].entry!;
        const rows = await game.storage.sql<{ resource: string; }[]>`
            select ri_resource as resource from resource_inbox where ri_topic_id = 'app:relic:tournament-clock'
        `;
        expect(rows).toHaveLength(1);
        const deadline = decodeRelicGameCommand(JSON.parse(JSON.parse(rows[0].resource).payload.resource));
        if (deadline.operation !== 'tournament-clock') {
            throw new Error('Expected the durable round clock');
        }
        game.nowEpochMs = deadline.clock.dueAtEpochMs;
        const cold = createRelicGameInboxFixture(game, {});
        const outbox = new OutboxQueueReader(new PSqlQueueBox(cold.resources, () => Temporal.Instant.fromEpochMilliseconds(game.nowEpochMs)));
        installRelicTournamentClock({ outbox, inbox: cold.inbox, nowEpochMs: () => game.nowEpochMs });
        // Queue claims use PostgreSQL time; advance only the logically due row in this accelerated clock test.
        await game.storage.sql`update resource_inbox set next_ts = now() at time zone 'UTC'
            where ri_topic_id = 'app:relic:tournament-clock' and next_ts <= ${new Date(game.nowEpochMs).toISOString()}::timestamp`;
        await outbox.dequeueOutbox(OutboxQueueReader.OUTBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
        await cold.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
        expect((await game.service.readCurrentSnapshot(game.command, 'relic-clock'))?.phase).toBe('review');
        const after = (await game.data.read(game.ref))[0].entry!;
        expect(after.revision).toBe(before.revision + 1);
        game.nowEpochMs += 1;
        await cold.inbox.enqueueTournamentClock(deadline, 'clock-redelivery-test');
        await cold.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
        expect((await game.data.read(game.ref))[0].entry!.revision).toBe(after.revision);
    }
    finally {
        await game.storage.close();
    }
}, 20000);
