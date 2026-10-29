import {
    applyRelicCommand,
    createRelicGame,
    isRelicCommand,
    isRelicSnapshot,
    RELIC_PROTOCOL_VERSION,
    toPublicRelicSnapshot,
    type RelicCommand,
    type RelicGameState
} from '@relic-hunters/mod.ts';
import { decodeRelicGameStateAppData } from '@relic-hunters/server/decode-relic-game-state-app-data.ts';
import { encodeRelicGameStateAppData } from '@relic-hunters/server/encode-relic-game-state-app-data.ts';
import { captureRelicGameMove, toRelicCommand } from '@relic-hunters/server/relic-game-move.ts';
import { describe, expect, it } from 'vitest';
import { requireRelicCommandApplied } from './require-relic-command-applied.ts';

const participants = ['alice', 'bob'].map((sessionId) => ({ sessionId, participationKey: `${sessionId}-membership` }));
const alice = { senderId: 'alice', now: 10, presentPlayerIds: ['alice', 'bob'], rematchParticipants: participants };
const bob = { ...alice, senderId: 'bob' };
const identity = { completedGameId: 'room:1', settingsKey: 'round-limit:60000:0' };
const baseCommand = { protocolVersion: RELIC_PROTOCOL_VERSION, gameId: 'room', username: 'Alice' };
const readyCommand = {
    ...baseCommand,
    ...identity,
    kind: 'set-rematch-ready',
    ready: true,
    participationKey: 'alice-membership',
    characterId: 'kael-ironstride'
} as const;
const startCommand = { ...baseCommand, ...identity, kind: 'start-rematch' } as const;

function completedExpedition(): RelicGameState {
    const joinedAlice = requireRelicCommandApplied(applyRelicCommand(createRelicGame('room', 'room', 1), {
        ...baseCommand,
        kind: 'join-expedition',
        characterId: 'kael-ironstride'
    }, alice)).state;
    const joinedBob = requireRelicCommandApplied(applyRelicCommand(joinedAlice, {
        ...baseCommand,
        username: 'Bob',
        kind: 'join-expedition',
        characterId: 'nyra-vale'
    }, bob)).state;
    return {
        ...joinedBob,
        phase: 'finished',
        winnerIds: ['bob'],
        players: joinedBob.players.map((player) => ({ ...player, escaped: true, score: player.playerId === 'bob' ? 30 : 5 }))
    };
}

function confirmBoth(): RelicGameState {
    const confirmedAlice = requireRelicCommandApplied(applyRelicCommand(completedExpedition(), readyCommand, alice)).state;
    return requireRelicCommandApplied(applyRelicCommand(confirmedAlice, {
        ...readyCommand,
        username: 'Bob',
        participationKey: 'bob-membership',
        characterId: 'nyra-vale'
    }, bob)).state;
}

describe('Relic play again together', () => {
    it('keeps completed results intact while accepting session consent and cancelling it', () => {
        const completed = completedExpedition();
        const prepared = requireRelicCommandApplied(applyRelicCommand(completed, readyCommand, alice)).state;
        expect(prepared.phase).toBe('finished');
        expect(prepared.players).toEqual(completed.players);
        expect(prepared.winnerIds).toEqual(['bob']);
        expect(prepared.events).toEqual(completed.events);
        expect(prepared.rematch?.preparation.players).toEqual([
            { sessionId: 'alice', ready: true, participationKey: 'alice-membership' },
            { sessionId: 'bob', ready: false }
        ]);
        expect(applyRelicCommand(prepared, startCommand, alice).left?.code).toBe('players-not-ready');
        const cancelled = requireRelicCommandApplied(applyRelicCommand(prepared, { ...readyCommand, ready: false }, alice)).state;
        expect(cancelled.rematch?.preparation.players[0].ready).toBe(false);
    });

    it('only lets the Keeper start a fresh captured expedition with consenting hunters and their characters', () => {
        const prepared = confirmBoth();
        expect(applyRelicCommand(prepared, startCommand, bob).left?.code).toBe('leader-required');
        expect(applyRelicCommand(prepared, startCommand, alice).left?.code).toBe('initial-state-missing');
        const next = requireRelicCommandApplied(applyRelicCommand(prepared, startCommand, {
            ...alice,
            now: 20,
            nextExpedition: createRelicGame('room', 'room', 15)
        })).state;
        expect(next).toMatchObject({ gameId: 'room', roomId: 'room', phase: 'planning', adminPlayerId: 'alice', createdAtEpochMs: 15 });
        expect(next.rematch).toBeUndefined();
        expect(next.players.map((player) => [player.playerId, player.characterId, player.score, player.escaped, player.roomId]))
            .toEqual([['alice', 'kael-ironstride', 0, false, 'entrance'], ['bob', 'nyra-vale', 0, false, 'entrance']]);
        expect(next.pendingActions).toEqual([]);
        expect(next.winnerIds).toEqual([]);
        expect(applyRelicCommand(next, startCommand, { ...alice, nextExpedition: createRelicGame('room', 'room', 30) }).left?.code)
            .toBe('stale-preparation');
        expect(applyRelicCommand(next, readyCommand, alice).left?.code).toBe('stale-preparation');
    });

    it('rechecks presence at start without losing same-session consent during a disconnect', () => {
        const prepared = confirmBoth();
        const next = requireRelicCommandApplied(applyRelicCommand(prepared, startCommand, {
            ...alice,
            presentPlayerIds: ['alice'],
            rematchParticipants: participants.filter((participant) => participant.sessionId === 'alice'),
            nextExpedition: createRelicGame('room', 'room', 15)
        })).state;
        expect(next.players.map((player) => player.playerId)).toEqual(['alice']);
        const reconnected = requireRelicCommandApplied(applyRelicCommand(prepared, startCommand, {
            ...alice,
            nextExpedition: createRelicGame('room', 'room', 16)
        })).state;
        expect(reconnected.players.map((player) => player.playerId)).toEqual(['alice', 'bob']);
    });

    it('invalidates consent on setup changes and refuses an old confirmation even after settings change back', () => {
        const prepared = confirmBoth();
        const changed = requireRelicCommandApplied(applyRelicCommand(prepared, {
            ...baseCommand,
            ...identity,
            kind: 'set-rematch-round-limit',
            timeLimitMs: 180_000
        }, { ...alice, now: 21 })).state;
        expect(changed.rematch?.preparation.players.every((player) => !player.ready)).toBe(true);
        expect(changed.roundTimeLimitMs).toBe(60_000);
        expect(changed.rematch?.roundTimeLimitMs).toBe(180_000);
        expect(applyRelicCommand(changed, readyCommand, alice).left?.code).toBe('stale-preparation');
        const restored = requireRelicCommandApplied(applyRelicCommand(changed, {
            ...baseCommand,
            ...identity,
            settingsKey: changed.rematch!.preparation.settingsKey,
            kind: 'set-rematch-round-limit',
            timeLimitMs: 60_000
        }, { ...alice, now: 22 })).state;
        expect(applyRelicCommand(restored, readyCommand, alice).left?.code).toBe('stale-preparation');
        expect(applyRelicCommand(prepared, { ...baseCommand, kind: 'start-expedition' }, alice).left?.code)
            .toBe('rematch-required');
        expect(applyRelicCommand(prepared, { ...baseCommand, kind: 'set-round-limit', timeLimitMs: 180_000 }, alice).left?.code)
            .toBe('rematch-required');
    });

    it('lets an eligible newcomer opt in without changing the previous game results', () => {
        const prepared = requireRelicCommandApplied(applyRelicCommand(completedExpedition(), {
            ...readyCommand,
            username: 'Carol',
            participationKey: 'carol-membership',
            characterId: 'oryn-starcoil'
        }, {
            ...alice,
            senderId: 'carol',
            presentPlayerIds: ['alice', 'bob', 'carol'],
            rematchParticipants: [...participants, { sessionId: 'carol', participationKey: 'carol-membership' }]
        })).state;
        expect(prepared.players.map((player) => player.playerId)).toEqual(['alice', 'bob']);
        expect(prepared.rematch?.hunters.find((hunter) => hunter.playerId === 'carol'))
            .toEqual({ playerId: 'carol', username: 'Carol', characterId: 'oryn-starcoil' });
        expect(
            applyRelicCommand(prepared, readyCommand, {
                ...alice,
                senderId: 'spectator',
                presentPlayerIds: ['alice', 'bob']
            }).left?.code
        ).toBe('player-required');
    });

    it('lets the remaining player take Keeper after expiry without discarding preparation', () => {
        const prepared = confirmBoth();
        const successor = requireRelicCommandApplied(applyRelicCommand(prepared, {
            ...baseCommand,
            kind: 'take-keeper',
            username: 'Bob'
        }, { ...bob, presentPlayerIds: ['bob'] })).state;
        expect(successor.adminPlayerId).toBe('bob');
        expect(successor.rematch).toEqual(prepared.rematch);
        const next = requireRelicCommandApplied(applyRelicCommand(successor, startCommand, {
            ...bob,
            presentPlayerIds: ['bob'],
            rematchParticipants: participants.filter((participant) => participant.sessionId === 'bob'),
            nextExpedition: createRelicGame('room', 'room', 15)
        })).state;
        expect(next.adminPlayerId).toBe('bob');
        expect(next.players.map((player) => player.playerId)).toEqual(['bob']);
    });

    it('withdraws a finished-game candidate and transfers Keeper without rewriting banked results', () => {
        const prepared = confirmBoth();
        const departed = requireRelicCommandApplied(applyRelicCommand(prepared, {
            ...baseCommand,
            kind: 'leave-expedition'
        }, alice)).state;
        expect(departed.players).toEqual(prepared.players);
        expect(departed.winnerIds).toEqual(prepared.winnerIds);
        expect(departed.adminPlayerId).toBe('bob');
        expect(departed.rematch?.preparation.players).toEqual([{ sessionId: 'bob', ready: true, participationKey: 'bob-membership' }]);
        expect(departed.rematch?.hunters.map((hunter) => hunter.playerId)).toEqual(['bob']);
    });

    it('round-trips validated preparation through public snapshots and durable commands/save decoding', () => {
        const prepared = confirmBoth();
        expect(decodeRelicGameStateAppData(encodeRelicGameStateAppData(prepared))).toEqual(prepared);
        const snapshot = toPublicRelicSnapshot(prepared);
        expect(snapshot.rematch).toEqual(prepared.rematch);
        expect(isRelicSnapshot(snapshot)).toBe(true);
        expect(isRelicSnapshot({ ...snapshot, rematch: { ...snapshot.rematch, hunters: [] } })).toBe(false);
        const commands: readonly RelicCommand[] = [readyCommand, startCommand, {
            ...baseCommand,
            ...identity,
            kind: 'set-rematch-round-limit',
            timeLimitMs: 180_000
        }];
        for (const command of commands) {
            expect(isRelicCommand(command)).toBe(true);
            expect(toRelicCommand(captureRelicGameMove(command))).toEqual(command);
            expect(isRelicCommand({ ...command, completedGameId: undefined })).toBe(false);
        }
    });
});
