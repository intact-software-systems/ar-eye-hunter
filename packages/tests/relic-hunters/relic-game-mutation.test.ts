import { createRelicGame, RELIC_PROTOCOL_VERSION } from '@relic-hunters/mod.ts';
import { captureRelicGameCommand } from '@relic-hunters/server/relic-game-mutation-service.ts';
import { writeAppOutboxInserts } from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import {
    describe,
    expect,
    it
} from 'vitest';
import { shouldAcceptRelicSnapshot } from '../../../apps/relic-hunters-v1/src/game/relic-snapshot-ordering.ts';
import { createTestAuthSession } from '../shared-server/rallar-system/group-state/group-state-test-runtime.ts';
import {
    connectGameSession,
    createGameFixture,
    prepareGameWrite,
    RELIC_FIXTURE_TRACE_ID
} from './relic-game-database-fixture.ts';

describe('Relic authoritative save mutations', () => {
    it('retries from the fresh group revision and initializes only once after a concurrent creator', async () => {
        const fixture = await createGameFixture();
        try {
            const initial = createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs);
            const first = await prepareGameWrite(fixture, fixture.command, initial);
            const second = await prepareGameWrite(fixture, { ...fixture.command, requestId: 'other-initialize' }, initial);
            const attempts = [first, second];
            const outcomes = await Promise.allSettled(
                attempts.map((attempt) => fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, attempt.computed)))
            );
            expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
            const conflictIndex = outcomes.findIndex((outcome) => outcome.status === 'rejected');
            expect(outcomes[conflictIndex]).toMatchObject({ status: 'rejected', reason: expect.any(RuntimeStateWriteConflictError) });
            const retryRead = await fixture.service.read(attempts[conflictIndex].ingress);
            const retry = fixture.service.compute({ ...retryRead, attemptCount: 1, traceId: 'trace-relic-game-mutation' });
            expect(retry.result).toEqual({ status: 'initialized', gameId: fixture.ref.groupId });
            expect(retry.save).toBeNull();
            expect((await fixture.data.read(fixture.ref))[0].entry?.revision).toBe(0);
        }
        finally {
            await fixture.storage.close();
        }
    });

    it('rebases overlapping joins so both issued players survive the winning save', async () => {
        const fixture = await createGameFixture();
        try {
            const guest = createTestAuthSession('guest');
            await connectGameSession(fixture, fixture.owner);
            await connectGameSession(fixture, guest);
            const initial = createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs);
            const ensure = await prepareGameWrite(fixture, fixture.command, initial);
            await fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, ensure.computed));
            const attempts = await Promise.all([fixture.owner, guest].map((session) =>
                prepareGameWrite(fixture, {
                    ...fixture.command,
                    operation: 'command',
                    requestId: `join-${session.sessionId}`,
                    actor: { clientId: session.clientId, sessionId: session.sessionId, issuedAtEpochMs: session.issuedAtEpochMs },
                    move: { protocolVersion: RELIC_PROTOCOL_VERSION, gameId: fixture.ref.groupId, kind: 'join-expedition', username: session.username }
                }, null)
            ));
            const outcomes = await Promise.allSettled(
                attempts.map((attempt) => fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, attempt.computed)))
            );
            expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
            const conflictIndex = outcomes.findIndex((outcome) => outcome.status === 'rejected');
            expect(outcomes[conflictIndex]).toMatchObject({ status: 'rejected', reason: expect.any(RuntimeStateWriteConflictError) });
            const freshRead = await fixture.service.read(attempts[conflictIndex].ingress);
            const rebased = fixture.service.compute({ ...freshRead, attemptCount: 1, traceId: 'trace-relic-game-mutation' });
            expect(fixture.service.validate({ ...freshRead, attemptCount: 1, traceId: 'trace-relic-game-mutation' }, rebased)).toEqual([]);
            await fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, rebased));
            const current = await fixture.service.readCurrentSnapshot(fixture.command, 'default-qbox-server');
            expect(current?.players.map((player) => player.playerId).sort()).toEqual([fixture.owner.sessionId, guest.sessionId].sort());
        }
        finally {
            await fixture.storage.close();
        }
    });

    it('keeps reset and command snapshots monotonic after a newer writer wins', async () => {
        const fixture = await createGameFixture();
        try {
            await connectGameSession(fixture, fixture.owner);
            const initial = createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs);
            const ensure = await prepareGameWrite(fixture, fixture.command, initial);
            await fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, ensure.computed));
            const resetIngress = fixture.service.capture(
                captureRelicGameCommand({ ...fixture.command, operation: 'reset', requestId: 'captured-reset' }),
                initial,
                'default-qbox-server'
            );
            fixture.nowEpochMs += 1_000;
            const joined = await prepareGameWrite(fixture, {
                ...fixture.command,
                operation: 'command',
                requestId: 'newer-join',
                move: { protocolVersion: RELIC_PROTOCOL_VERSION, kind: 'join-expedition', gameId: fixture.ref.groupId, username: 'owner' }
            }, null);
            await fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, joined.computed));
            const latest = await fixture.service.readCurrentSnapshot(fixture.command, 'default-qbox-server');
            fixture.nowEpochMs -= 500;
            const resetRead = await fixture.service.read(resetIngress);
            const reset = fixture.service.compute({ ...resetRead, attemptCount: 1, traceId: 'trace-relic-game-mutation' });
            expect(fixture.service.validate({ ...resetRead, attemptCount: 1, traceId: 'trace-relic-game-mutation' }, reset)).toEqual([]);
            await fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, reset));
            const afterReset = await fixture.service.readCurrentSnapshot(fixture.command, 'default-qbox-server');
            if (latest === null || afterReset === null) {
                throw new Error('Expected both committed snapshots');
            }
            expect(afterReset.updatedAtEpochMs).toBeGreaterThan(latest.updatedAtEpochMs);
            expect(shouldAcceptRelicSnapshot({ current: latest, candidate: afterReset })).toBe(true);
            const rejoin = await prepareGameWrite(fixture, {
                ...fixture.command,
                operation: 'command',
                requestId: 'clock-skew-join',
                move: { protocolVersion: RELIC_PROTOCOL_VERSION, kind: 'join-expedition', gameId: fixture.ref.groupId, username: 'owner' }
            }, null);
            await fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, rejoin.computed));
            const afterJoin = await fixture.service.readCurrentSnapshot(fixture.command, 'default-qbox-server');
            if (afterJoin === null) {
                throw new Error('Expected the later command snapshot');
            }
            expect(afterJoin.updatedAtEpochMs).toBeGreaterThan(afterReset.updatedAtEpochMs);
            expect(shouldAcceptRelicSnapshot({ current: afterReset, candidate: afterJoin })).toBe(true);
        }
        finally {
            await fixture.storage.close();
        }
    });

    it('rejects saves for archived rooms and detects tampering before transaction entry', async () => {
        const fixture = await createGameFixture();
        try {
            const initial = createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs);
            const prepared = await prepareGameWrite(fixture, fixture.command, initial);
            const stored = await fixture.repository.findGroupEntry(fixture.ref);
            if (!stored) {
                throw new Error('Expected the test room');
            }
            await fixture.repository.updateGroup({ ...stored.value, status: 'archived', archived: stored.value.updated, deleted: null }, stored.entry.revision);
            await expect(fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, prepared.computed)))
                .rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
            const retry = fixture.service.compute({ ...await fixture.service.read(prepared.ingress), attemptCount: 1, traceId: 'trace-relic-game-mutation' });
            expect(retry.result).toMatchObject({ status: 'refused', code: 'room-unavailable' });
            expect(retry.save).toBeNull();
            expect((await fixture.data.read(fixture.ref))[0].entry).toBeNull();
            expect(
                fixture.service.validate({ ...prepared.read, attemptCount: 1, traceId: 'trace-relic-game-mutation' }, { ...prepared.computed, save: null })
                    .length
            )
                .toBeGreaterThan(0);
        }
        finally {
            await fixture.storage.close();
        }
    });
    it('prepares reset publication atomically and rolls back the save when the final outbox collides', async () => {
        const fixture = await createGameFixture();
        try {
            const initial = createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs);
            const ensure = await prepareGameWrite(fixture, fixture.command, initial);
            await fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, ensure.computed));
            const before = (await fixture.data.read(fixture.ref))[0].entry;
            const reset = await prepareGameWrite(fixture, {
                ...fixture.command,
                operation: 'reset',
                requestId: 'reset-1'
            }, initial);
            expect(reset.computed.outboxWrites).toHaveLength(1);
            // The publication the attempt writes carries the trace of its queued command.
            expect(decodePersistedALMessage(reset.computed.outboxWrites[0]!.entry.resource).id.traceId)
                .toBe(RELIC_FIXTURE_TRACE_ID);
            expect(reset.computed.provenance).toHaveLength(1);
            expect(reset.computed.result).toEqual({ status: 'applied', gameId: fixture.ref.groupId });
            if (reset.computed.save?.operation !== 'save') {
                throw new Error('Expected the prepared reset save');
            }
            expect(JSON.parse(reset.computed.save.valueJson).createdAtEpochMs).toBe(initial.createdAtEpochMs + 1);
            await writeAppOutboxInserts(fixture.storage.sql, reset.computed.outboxWrites);
            await expect(fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, reset.computed)))
                .rejects.toThrow('App outbox insert did not create exactly one row');
            expect((await fixture.data.read(fixture.ref))[0].entry).toEqual(before);
        }
        finally {
            await fixture.storage.close();
        }
    });
    it('rejects a stale Keeper takeover after presence renews and recomputes authority on retry', async () => {
        const fixture = await createGameFixture();
        try {
            const guest = createTestAuthSession('guest');
            await connectGameSession(fixture, fixture.owner);
            await connectGameSession(fixture, guest);
            const ensure = await prepareGameWrite(fixture, fixture.command, createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs));
            await fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, ensure.computed));
            for (const session of [fixture.owner, guest]) {
                const joined = await prepareGameWrite(fixture, {
                    ...fixture.command,
                    operation: 'command',
                    requestId: `join-${session.sessionId}`,
                    actor: { clientId: session.clientId, sessionId: session.sessionId, issuedAtEpochMs: session.issuedAtEpochMs },
                    move: { protocolVersion: RELIC_PROTOCOL_VERSION, gameId: fixture.ref.groupId, kind: 'join-expedition', username: session.username }
                }, null);
                await fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, joined.computed));
            }
            const presence = await fixture.repository.findPresenceEntry({ ...fixture.ref, sessionId: fixture.owner.sessionId });
            if (!presence) {
                throw new Error('Expected the Keeper presence');
            }
            fixture.nowEpochMs += 10;
            await fixture.repository.updatePresence({ ...presence.value, expiresAtEpochMs: fixture.nowEpochMs - 1 }, presence.entry.revision);
            const takeover = await prepareGameWrite(fixture, {
                ...fixture.command,
                operation: 'command',
                requestId: 'take-keeper',
                actor: { clientId: guest.clientId, sessionId: guest.sessionId, issuedAtEpochMs: guest.issuedAtEpochMs },
                move: { protocolVersion: RELIC_PROTOCOL_VERSION, gameId: fixture.ref.groupId, kind: 'take-keeper', username: guest.username }
            }, null);
            expect(takeover.computed.result.status).toBe('applied');
            const expired = await fixture.repository.findPresenceEntry({ ...fixture.ref, sessionId: fixture.owner.sessionId });
            if (!expired) {
                throw new Error('Expected the retained expired lease');
            }
            await fixture.repository.updatePresence({ ...expired.value, expiresAtEpochMs: fixture.nowEpochMs + 60_000 }, expired.entry.revision);
            await expect(fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, takeover.computed)))
                .rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
            const current = await fixture.service.readCurrentSnapshot(fixture.command, 'default-qbox-server');
            expect(current?.adminPlayerId).toBe(fixture.owner.sessionId);
            const retryRead = await fixture.service.read(takeover.ingress);
            const retry = fixture.service.compute({ ...retryRead, attemptCount: 2, traceId: 'takeover-retry' });
            expect(retry.result).toMatchObject({ status: 'refused', message: 'The current Keeper is still present.' });
            expect(retry.save).toBeNull();
        }
        finally {
            await fixture.storage.close();
        }
    });

    it('rejects absence-based takeover when the Keeper presence is recreated before the write', async () => {
        const fixture = await createJoinedContinuityFixture();
        try {
            const presence = await fixture.repository.findPresenceEntry({ ...fixture.ref, sessionId: fixture.owner.sessionId });
            if (!presence) {
                throw new Error('Expected Keeper presence');
            }
            await fixture.repository.deletePresence({ ...fixture.ref, sessionId: fixture.owner.sessionId }, presence.entry.revision);
            const takeover = await prepareGameWrite(fixture, {
                ...fixture.command,
                operation: 'command',
                requestId: 'take-after-absence',
                actor: { clientId: fixture.guest.clientId, sessionId: fixture.guest.sessionId, issuedAtEpochMs: fixture.guest.issuedAtEpochMs },
                move: { protocolVersion: RELIC_PROTOCOL_VERSION, gameId: fixture.ref.groupId, kind: 'take-keeper', username: fixture.guest.username }
            }, null);
            expect(takeover.computed.result.status).toBe('applied');
            await fixture.repository.insertPresence(presence.value);
            await expect(fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, takeover.computed)))
                .rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
            const retryRead = await fixture.service.read(takeover.ingress);
            expect(fixture.service.compute({ ...retryRead, attemptCount: 2, traceId: 'recreated-presence' }).result)
                .toMatchObject({ status: 'refused', message: 'The current Keeper is still present.' });
        }
        finally {
            await fixture.storage.close();
        }
    });

    it('rejects a takeover after an expired Keeper row is replaced with the same revision', async () => {
        const fixture = await createJoinedContinuityFixture();
        try {
            const ref = { ...fixture.ref, sessionId: fixture.owner.sessionId };
            const presence = await fixture.repository.findPresenceEntry(ref);
            if (!presence) {
                throw new Error('Expected Keeper presence');
            }
            await fixture.repository.deletePresence(ref, presence.entry.revision);
            fixture.nowEpochMs += 10;
            await fixture.repository.insertPresence({ ...presence.value, expiresAtEpochMs: fixture.nowEpochMs - 1 });
            const takeover = await prepareGameWrite(fixture, {
                ...fixture.command,
                operation: 'command',
                requestId: 'take-before-recreation',
                actor: { clientId: fixture.guest.clientId, sessionId: fixture.guest.sessionId, issuedAtEpochMs: fixture.guest.issuedAtEpochMs },
                move: { protocolVersion: RELIC_PROTOCOL_VERSION, gameId: fixture.ref.groupId, kind: 'take-keeper', username: fixture.guest.username }
            }, null);
            expect(takeover.computed.result.status).toBe('applied');
            expect(takeover.computed.guard?.presenceRevision).toBe(0);
            await fixture.repository.deletePresence(ref, 0);
            await fixture.repository.insertPresence({ ...presence.value, expiresAtEpochMs: fixture.nowEpochMs + 60_000 });
            await expect(fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, takeover.computed)))
                .rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
            const read = await fixture.service.read(takeover.ingress);
            expect(fixture.service.compute({ ...read, attemptCount: 2, traceId: 'keeper-recreated' }).result)
                .toMatchObject({ status: 'refused', message: 'The current Keeper is still present.' });
        }
        finally {
            await fixture.storage.close();
        }
    });

    it('rebases competing takeovers over a committed turn and keeps exactly one new Keeper', async () => {
        const fixture = await createJoinedContinuityFixture();
        try {
            const contender = createTestAuthSession('contender');
            await connectGameSession(fixture, contender);
            const joined = await prepareGameWrite(fixture, {
                ...fixture.command,
                operation: 'command',
                requestId: 'join-contender',
                actor: { clientId: contender.clientId, sessionId: contender.sessionId, issuedAtEpochMs: contender.issuedAtEpochMs },
                move: { protocolVersion: RELIC_PROTOCOL_VERSION, gameId: fixture.ref.groupId, kind: 'join-expedition', username: contender.username }
            }, null);
            await fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, joined.computed));
            const started = await prepareGameWrite(fixture, {
                ...fixture.command,
                operation: 'command',
                requestId: 'start',
                move: { protocolVersion: RELIC_PROTOCOL_VERSION, gameId: fixture.ref.groupId, kind: 'start-expedition', username: fixture.owner.username }
            }, null);
            await fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, started.computed));
            const presence = await fixture.repository.findPresenceEntry({ ...fixture.ref, sessionId: fixture.owner.sessionId });
            if (!presence) {
                throw new Error('Expected Keeper presence');
            }
            fixture.nowEpochMs += 10;
            await fixture.repository.updatePresence({ ...presence.value, expiresAtEpochMs: fixture.nowEpochMs - 1 }, presence.entry.revision);
            const candidates = await Promise.all([fixture.guest, contender].map((hunter) =>
                prepareGameWrite(fixture, {
                    ...fixture.command,
                    operation: 'command',
                    requestId: `take-${hunter.sessionId}`,
                    actor: { clientId: hunter.clientId, sessionId: hunter.sessionId, issuedAtEpochMs: hunter.issuedAtEpochMs },
                    move: { protocolVersion: RELIC_PROTOCOL_VERSION, gameId: fixture.ref.groupId, kind: 'take-keeper', username: hunter.username }
                }, null)
            ));
            const turn = await prepareGameWrite(fixture, {
                ...fixture.command,
                operation: 'command',
                requestId: 'concurrent-turn',
                actor: { clientId: fixture.guest.clientId, sessionId: fixture.guest.sessionId, issuedAtEpochMs: fixture.guest.issuedAtEpochMs },
                move: {
                    protocolVersion: RELIC_PROTOCOL_VERSION,
                    gameId: fixture.ref.groupId,
                    kind: 'submit-action',
                    username: fixture.guest.username,
                    action: { kind: 'move', targetRoomId: 'hallway' }
                }
            }, null);
            await fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, turn.computed));
            for (const candidate of candidates) {
                await expect(fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, candidate.computed)))
                    .rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
            }
            const retries = await Promise.all(candidates.map(async (candidate) => {
                const read = await fixture.service.read(candidate.ingress);
                const attempt = { ...read, attemptCount: 2, traceId: 'competing-takeover' };
                const computed = fixture.service.compute(attempt);
                expect(fixture.service.validate(attempt, computed)).toEqual([]);
                return computed;
            }));
            const outcomes = await Promise.allSettled(
                retries.map((computed) => fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, computed)))
            );
            expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
            const loser = outcomes.findIndex((outcome) => outcome.status === 'rejected');
            expect(outcomes[loser]).toMatchObject({ status: 'rejected', reason: expect.any(RuntimeStateWriteConflictError) });
            const finalRead = await fixture.service.read(candidates[loser].ingress);
            expect(fixture.service.compute({ ...finalRead, attemptCount: 3, traceId: 'loser-reauthorization' }).result)
                .toMatchObject({ status: 'refused', message: 'The current Keeper is still present.' });
            const winner = loser === 0 ? contender.sessionId : fixture.guest.sessionId;
            const current = await fixture.service.readCurrentSnapshot({
                ...fixture.command,
                actor: { clientId: fixture.guest.clientId, sessionId: fixture.guest.sessionId, issuedAtEpochMs: fixture.guest.issuedAtEpochMs }
            }, 'default-qbox-server');
            expect(current?.adminPlayerId).toBe(winner);
            expect(current?.submittedPlayerIds).toEqual([fixture.guest.sessionId]);
            expect(current?.players).toHaveLength(3);
            expect(current?.phase).toBe('planning');
        }
        finally {
            await fixture.storage.close();
        }
    });
});

async function createJoinedContinuityFixture() {
    const fixture = await createGameFixture();
    const guest = createTestAuthSession('guest');
    await connectGameSession(fixture, fixture.owner);
    await connectGameSession(fixture, guest);
    const initial = createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs);
    const ensure = await prepareGameWrite(fixture, fixture.command, initial);
    await fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, ensure.computed));
    for (const hunter of [fixture.owner, guest]) {
        const joined = await prepareGameWrite(fixture, {
            ...fixture.command,
            operation: 'command',
            requestId: `join-${hunter.sessionId}`,
            actor: { clientId: hunter.clientId, sessionId: hunter.sessionId, issuedAtEpochMs: hunter.issuedAtEpochMs },
            move: { protocolVersion: RELIC_PROTOCOL_VERSION, gameId: fixture.ref.groupId, kind: 'join-expedition', username: hunter.username }
        }, null);
        await fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, joined.computed));
    }
    return Object.assign(fixture, { guest });
}
