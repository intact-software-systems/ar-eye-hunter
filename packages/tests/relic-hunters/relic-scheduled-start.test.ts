import { applyRelicCommand, createRelicGame, RELIC_PROTOCOL_VERSION } from '@relic-hunters/mod.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { describe, expect, it } from 'vitest';
import { connectGameSession, createGameFixture, prepareGameWrite, RELIC_FIXTURE_TRACE_ID } from './relic-game-database-fixture.ts';
import { requireRelicCommandApplied } from './require-relic-command-applied.ts';

describe('scheduled Relic authority', () => {
    it('refuses an early start and evaluates a queued command with the fresh attempt clock', async () => {
        const fixture = await createGameFixture('scheduled-expedition', 30_000);
        try {
            await connectGameSession(fixture, fixture.owner);
            const initial = requireRelicCommandApplied(applyRelicCommand(createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs), {
                protocolVersion: RELIC_PROTOCOL_VERSION,
                gameId: fixture.ref.groupId,
                username: fixture.owner.username,
                kind: 'join-expedition'
            }, { senderId: fixture.owner.sessionId, presentPlayerIds: [fixture.owner.sessionId], now: fixture.nowEpochMs })).state;
            const initialized = await prepareGameWrite(fixture, fixture.command, initial);
            await fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, initialized.computed));
            const start = await prepareGameWrite(fixture, {
                ...fixture.command,
                operation: 'command',
                requestId: 'scheduled-start',
                move: {
                    protocolVersion: RELIC_PROTOCOL_VERSION,
                    gameId: fixture.ref.groupId,
                    username: fixture.owner.username,
                    kind: 'start-expedition'
                }
            }, null);
            expect(start.computed.result).toMatchObject({ status: 'refused', code: 'session-not-started' });
            expect(start.computed.save).toBeNull();
            expect(start.computed.guard).not.toBeNull();
            const refusal = start.computed.outboxWrites[0];
            if (!refusal) {
                throw new Error('Early start must publish its refusal to the requesting player');
            }
            const message = decodePersistedALMessage(refusal.entry.resource);
            expect(message.targets).toMatchObject({ scope: 'principal', principalRef: { principalId: fixture.owner.clientId } });
            expect(JSON.parse(message.payload.resource)).toMatchObject({
                kind: 'command-refused',
                text: 'Wait until the scheduled start time before starting gameplay.'
            });
            fixture.nowEpochMs += 30_000;
            const read = await fixture.service.read(start.ingress);
            const attempt = { ...read, attemptCount: 2, traceId: RELIC_FIXTURE_TRACE_ID };
            const ready = fixture.service.compute(attempt);
            expect(fixture.service.validate(attempt, ready)).toEqual([]);
            expect(ready.result).toMatchObject({ status: 'applied' });
            expect(ready.save).not.toBeNull();
            await fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, ready));
        }
        finally {
            await fixture.storage.close();
        }
    });
});
