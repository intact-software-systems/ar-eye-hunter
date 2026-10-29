import { createRelicGame, RELIC_PROTOCOL_VERSION, toRelicRoundTrackKey, type RelicGameState } from '@relic-hunters/mod.ts';
import { createRelicRematch } from '@relic-hunters/src/relic-rematch.ts';
import { AuthSessionPersistence } from '@shared-server/rallar-system/auth/persistence/auth-session-persistence.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { readRallarGameParticipants } from '@shared/rallar-game/read-rallar-game-participants.ts';
import { describe, expect, it } from 'vitest';
import { createTestAuthSession } from '../shared-server/rallar-system/group-state/group-state-test-runtime.ts';
import { connectGameSession, createGameFixture, prepareGameWrite } from './relic-game-database-fixture.ts';

async function createRematchFixture() {
    const fixture = await createGameFixture();
    const guest = createTestAuthSession('guest');
    await connectGameSession(fixture, fixture.owner);
    await connectGameSession(fixture, guest);
    const initial: RelicGameState = {
        ...createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs),
        phase: 'finished',
        adminPlayerId: fixture.owner.sessionId,
        players: [fixture.owner, guest].map((session) => ({
            playerId: session.sessionId,
            username: session.username,
            characterId: 'kael-ironstride',
            roomId: 'exit',
            health: 3,
            escaped: true,
            defeated: false,
            score: 5,
            relicIds: []
        })),
        winnerIds: [fixture.owner.sessionId, guest.sessionId]
    };
    const rematch = createRelicRematch(initial).right!;
    const group = await fixture.repository.readSnapshotWithAuthorityGuard(fixture.ref);
    const owner = readRallarGameParticipants(group?.snapshot, fixture.nowEpochMs).find((participant) => participant.sessionId === fixture.owner.sessionId)!;
    const ensure = await prepareGameWrite(fixture, fixture.command, {
        ...initial,
        rematch: {
            ...rematch,
            preparation: {
                ...rematch.preparation,
                players: rematch.preparation.players.map((player) =>
                    player.sessionId === fixture.owner.sessionId ? { ...player, ready: true as const, participationKey: owner.participationKey } : player
                )
            }
        }
    });
    await fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, ensure.computed));
    const start = {
        ...fixture.command,
        operation: 'command' as const,
        requestId: 'rematch-start',
        move: {
            protocolVersion: RELIC_PROTOCOL_VERSION,
            gameId: fixture.ref.groupId,
            username: fixture.owner.username,
            kind: 'start-rematch' as const,
            completedGameId: toRelicRoundTrackKey(initial),
            settingsKey: rematch.preparation.settingsKey
        }
    };
    return Object.assign(fixture, { guest, start, initial });
}

async function confirmGuest(fixture: Awaited<ReturnType<typeof createRematchFixture>>): Promise<void> {
    const guest = fixture.guest;
    const group = await fixture.repository.readSnapshotWithAuthorityGuard(fixture.ref);
    const participationKey =
        readRallarGameParticipants(group?.snapshot, fixture.nowEpochMs).find((entry) => entry.sessionId === guest.sessionId)!.participationKey;
    const ready = await prepareGameWrite(fixture, {
        ...fixture.start,
        requestId: 'guest-ready',
        actor: { clientId: guest.clientId, sessionId: guest.sessionId, issuedAtEpochMs: guest.issuedAtEpochMs },
        move: { ...fixture.start.move, username: guest.username, kind: 'set-rematch-ready', ready: true, participationKey, characterId: 'kael-ironstride' }
    }, null);
    expect(ready.computed.result.status).toBe('applied');
    await fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, ready.computed));
}

async function expireGuest(fixture: Awaited<ReturnType<typeof createRematchFixture>>) {
    const ref = { ...fixture.ref, sessionId: fixture.guest.sessionId };
    const presence = await fixture.repository.findPresenceEntry(ref);
    if (!presence) {
        throw new Error('Expected the guest lease');
    }
    fixture.nowEpochMs += 10;
    await fixture.repository.updatePresence({ ...presence.value, expiresAtEpochMs: fixture.nowEpochMs - 1 }, presence.entry.revision);
    return { ref, presence };
}

describe('Relic rematch optimistic mutation', () => {
    it('captures a new proposal only for a ready current leader and refuses Reset as a consent bypass', async () => {
        const fixture = await createRematchFixture();
        try {
            const waiting = await prepareGameWrite(fixture, fixture.start, null);
            expect(fixture.service.needsInitialState(waiting.read)).toBe(false);
            await confirmGuest(fixture);
            const ready = await prepareGameWrite(fixture, fixture.start, null);
            expect(fixture.service.needsInitialState(ready.read)).toBe(true);
            const reset = await prepareGameWrite(fixture, {
                ...fixture.command,
                operation: 'reset',
                requestId: 'reset-bypass'
            }, createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs + 1));
            expect(fixture.service.needsInitialState(reset.read)).toBe(false);
            expect(reset.computed.result).toMatchObject({ status: 'refused', code: 'rematch-required' });
            expect(reset.computed.save).toBeNull();
        }
        finally {
            await fixture.storage.close();
        }
    });

    it.each([false, true])('excludes expired authentication with live presence (ready=%s)', async (ready) => {
        const fixture = await createRematchFixture();
        try {
            if (ready) {
                await confirmGuest(fixture);
            }
            const sessions = new AuthSessionPersistence(fixture.runtime);
            await sessions.putSession({ ...fixture.guest, expiresAtEpochMs: fixture.nowEpochMs + 1 });
            fixture.nowEpochMs += 2;
            const proposal = createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs + 1);
            const prepared = await prepareGameWrite(fixture, fixture.start, proposal);
            expect(prepared.computed.result.status).toBe('applied');
            await fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, prepared.computed));
            const current = await fixture.service.readCurrentSnapshot(fixture.command, 'default-qbox-server');
            expect(current?.players.map((player) => player.playerId)).toEqual([fixture.owner.sessionId]);
        }
        finally {
            await fixture.storage.close();
        }
    });

    it('rechecks candidate authentication after a revocation races with start', async () => {
        const fixture = await createRematchFixture();
        try {
            await confirmGuest(fixture);
            const proposal = createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs + 1);
            const prepared = await prepareGameWrite(fixture, fixture.start, proposal);
            await new AuthSessionPersistence(fixture.runtime).deleteSession(fixture.guest);
            await expect(fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, prepared.computed)))
                .rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
            const retry = await prepareGameWrite(fixture, fixture.start, proposal);
            await fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, retry.computed));
            const current = await fixture.service.readCurrentSnapshot(fixture.command, 'default-qbox-server');
            expect(current?.players.map((player) => player.playerId)).toEqual([fixture.owner.sessionId]);
        }
        finally {
            await fixture.storage.close();
        }
    });

    it('starts only once when two valid starts overlap and reauthorizes the losing attempt', async () => {
        const fixture = await createRematchFixture();
        try {
            await confirmGuest(fixture);
            const proposal = createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs + 1);
            const first = await prepareGameWrite(fixture, fixture.start, proposal);
            const second = await prepareGameWrite(fixture, { ...fixture.start, requestId: 'other-start' }, proposal);
            expect(first.computed.result.status).toBe('applied');
            await fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, first.computed));
            await expect(fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, second.computed)))
                .rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
            const retry = await prepareGameWrite(fixture, { ...fixture.start, requestId: 'other-start' }, proposal);
            expect(retry.computed.result).toMatchObject({ status: 'refused', code: 'rule-refused' });
            const current = await fixture.service.readCurrentSnapshot(fixture.command, 'default-qbox-server');
            expect(current?.phase).toBe('planning');
            expect(current?.createdAtEpochMs).toBe(proposal.createdAtEpochMs);
            expect(current?.players.map((player) => player.playerId).sort())
                .toEqual([fixture.owner.sessionId, fixture.guest.sessionId].sort());
            expect(current?.rematch).toBeUndefined();
        }
        finally {
            await fixture.storage.close();
        }
    });

    it.each(['renew', 'recreate', 'absent'] as const)('fences %s of an unconfirmed guest lease before commit', async (race) => {
        const fixture = await createRematchFixture();
        try {
            const { ref, presence } = await expireGuest(fixture);
            if (race === 'absent' || race === 'recreate') {
                const expired = await fixture.repository.findPresenceEntry(ref);
                if (!expired) {
                    throw new Error('Expected retained expired presence');
                }
                await fixture.repository.deletePresence(ref, expired.entry.revision);
                if (race === 'recreate') {
                    await fixture.repository.insertPresence(expired.value);
                }
            }
            const proposal = createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs + 1);
            const prepared = await prepareGameWrite(fixture, fixture.start, proposal);
            expect(prepared.computed.result.status).toBe('applied');
            if (race === 'renew') {
                const expired = await fixture.repository.findPresenceEntry(ref);
                if (!expired) {
                    throw new Error('Expected expired presence');
                }
                await fixture.repository.updatePresence({ ...expired.value, expiresAtEpochMs: fixture.nowEpochMs + 60_000 }, expired.entry.revision);
            }
            else {
                if (race === 'recreate') {
                    const expired = await fixture.repository.findPresenceEntry(ref);
                    if (!expired) {
                        throw new Error('Expected expired presence');
                    }
                    await fixture.repository.deletePresence(ref, expired.entry.revision);
                }
                await fixture.repository.insertPresence({ ...presence.value, expiresAtEpochMs: fixture.nowEpochMs + 60_000 });
            }
            await expect(fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, prepared.computed)))
                .rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
            const retry = await prepareGameWrite(fixture, fixture.start, proposal);
            expect(retry.computed.result).toMatchObject({ status: 'refused', message: 'Waiting for the remaining players to confirm.' });
            const current = await fixture.service.readCurrentSnapshot(fixture.command, 'default-qbox-server');
            expect(current?.phase).toBe('finished');
            expect(current?.createdAtEpochMs).toBe(fixture.initial.createdAtEpochMs);
        }
        finally {
            await fixture.storage.close();
        }
    });
});
