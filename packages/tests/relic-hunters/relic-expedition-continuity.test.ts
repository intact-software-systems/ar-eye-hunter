import {
    applyRelicCommand,
    createRelicGame,
    isRelicCommand,
    RELIC_PROTOCOL_VERSION,
    type RelicGameState
} from '@relic-hunters/mod.ts';
import { toRelicRoundTransitionEvent } from '@relic-hunters/server/to-relic-round-transition-event.ts';
import { describe, expect, it } from 'vitest';

import { requireRelicCommandApplied } from './require-relic-command-applied.ts';

function expedition(phase: RelicGameState['phase'] = 'lobby'): RelicGameState {
    return {
        ...createRelicGame('expedition', 'expedition', 1),
        phase,
        round: phase === 'lobby' ? 0 : 1,
        roundStartedAtEpochMs: phase === 'planning' ? 10 : undefined,
        adminPlayerId: 'alice-session',
        players: [
            {
                playerId: 'alice-session',
                username: 'Alice',
                characterId: 'kael-ironstride',
                roomId: 'storage',
                health: 3,
                escaped: false,
                defeated: false,
                score: 10,
                relicIds: ['coin']
            },
            {
                playerId: 'bob-session',
                username: 'Bob',
                characterId: 'nyra-vale',
                roomId: 'entrance',
                health: 3,
                escaped: false,
                defeated: false,
                score: 0,
                relicIds: []
            }
        ],
        relics: [{ id: 'coin', name: 'Coin', value: 10, roomId: 'storage', foundBy: 'alice-session', carriedBy: 'alice-session' }]
    };
}

const command = { protocolVersion: RELIC_PROTOCOL_VERSION, gameId: 'expedition', username: 'Alice' };

describe('Relic expedition continuity', () => {
    it('accepts explicit withdrawal and Keeper takeover on the public command boundary', () => {
        expect(isRelicCommand({ ...command, kind: 'leave-expedition' })).toBe(true);
        expect(isRelicCommand({ ...command, kind: 'take-keeper' })).toBe(true);
    });

    it('withdraws the Keeper, drops unbanked relics and lets the present successor start', () => {
        const previous = expedition();
        const unchanged = structuredClone(previous);
        const left = requireRelicCommandApplied(applyRelicCommand(previous, {
            ...command,
            kind: 'leave-expedition'
        }, { senderId: 'alice-session', now: 20, presentPlayerIds: ['alice-session', 'bob-session'] })).state;
        expect(previous).toEqual(unchanged);
        expect(left.players.map((player) => player.playerId)).toEqual(['bob-session']);
        expect(left.adminPlayerId).toBe('bob-session');
        expect(left.relics[0]).toMatchObject({ roomId: 'storage', foundBy: 'alice-session' });
        expect(left.relics[0]?.carriedBy).toBeUndefined();
        const started = requireRelicCommandApplied(applyRelicCommand(left, {
            ...command,
            username: 'Bob',
            kind: 'start-expedition'
        }, { senderId: 'bob-session', now: 21, presentPlayerIds: ['bob-session'] })).state;
        expect(started.phase).toBe('planning');
    });

    it('removes a departing pending plan and resolves the remaining locked plans immediately', () => {
        const previous: RelicGameState = {
            ...expedition('planning'),
            pendingActions: [
                { playerId: 'alice-session', username: 'Alice', action: { kind: 'search' }, submittedAtEpochMs: 11 },
                { playerId: 'bob-session', username: 'Bob', action: { kind: 'move', targetRoomId: 'hallway' }, submittedAtEpochMs: 12 }
            ]
        };
        const result = requireRelicCommandApplied(applyRelicCommand(previous, {
            ...command,
            kind: 'leave-expedition'
        }, { senderId: 'alice-session', now: 20, presentPlayerIds: ['alice-session', 'bob-session'] }));
        expect(result.resolvedRound).toBe(true);
        expect(result.state.phase).toBe('review');
        expect(result.state.pendingActions).toEqual([]);
        expect(result.state.players.map((player) => [player.playerId, player.roomId])).toEqual([['bob-session', 'hallway']]);
        expect(result.state.roomInvestigations).toEqual([]);
    });

    it('keeps a disconnected hunter and their plan when another present hunter takes over', () => {
        const previous: RelicGameState = {
            ...expedition('planning'),
            pendingActions: [{ playerId: 'alice-session', username: 'Alice', action: { kind: 'search' }, submittedAtEpochMs: 11 }]
        };
        const taken = requireRelicCommandApplied(applyRelicCommand(previous, {
            ...command,
            username: 'Bob',
            kind: 'take-keeper'
        }, { senderId: 'bob-session', now: 20, presentPlayerIds: ['bob-session'] })).state;
        expect(taken.adminPlayerId).toBe('bob-session');
        expect(taken.players).toEqual(previous.players);
        expect(taken.pendingActions).toEqual(previous.pendingActions);
        expect(
            applyRelicCommand(taken, {
                ...command,
                kind: 'take-keeper'
            }, { senderId: 'alice-session', now: 21, presentPlayerIds: ['alice-session', 'bob-session'] }).left?.code
        ).toBe('keeper-present');
        const resumed = requireRelicCommandApplied(applyRelicCommand(taken, {
            ...command,
            kind: 'join-expedition'
        }, { senderId: 'alice-session', now: 22, presentPlayerIds: ['alice-session', 'bob-session'] })).state;
        expect(resumed.adminPlayerId).toBe('bob-session');
        expect(resumed.players[0]).toEqual(previous.players[0]);
    });

    it('refuses takeover by an absent or unjoined hunter and while the Keeper is present', () => {
        const previous = expedition('review');
        for (
            const candidate of [
                { senderId: 'bob-session', presentPlayerIds: ['alice-session', 'bob-session'], code: 'keeper-present' },
                { senderId: 'bob-session', presentPlayerIds: [], code: 'present-hunter-required' },
                { senderId: 'watcher-session', presentPlayerIds: ['watcher-session'], code: 'participant-required' }
            ]
        ) {
            const result = applyRelicCommand(previous, { ...command, kind: 'take-keeper' }, { ...candidate, now: 20 });
            expect(result.left?.code).toBe(candidate.code);
            expect(result.right).toBeUndefined();
        }
    });

    it('makes repeated withdrawal harmless and does not allow returning to an ongoing expedition', () => {
        const left = requireRelicCommandApplied(applyRelicCommand(expedition('planning'), {
            ...command,
            kind: 'leave-expedition'
        }, { senderId: 'alice-session', now: 20, presentPlayerIds: ['alice-session', 'bob-session'] })).state;
        const repeated = requireRelicCommandApplied(applyRelicCommand(left, {
            ...command,
            kind: 'leave-expedition'
        }, { senderId: 'alice-session', now: 21, presentPlayerIds: ['alice-session', 'bob-session'] })).state;
        expect(repeated).toEqual(left);
        expect(
            applyRelicCommand(left, {
                ...command,
                kind: 'join-expedition'
            }, { senderId: 'alice-session', now: 22, presentPlayerIds: ['alice-session', 'bob-session'] }).left?.code
        ).toBe('expedition-started');
    });

    it('finishes when the last active hunter withdraws and preserves previously banked results', () => {
        const previous: RelicGameState = {
            ...expedition('planning'),
            players: expedition().players.map((player) =>
                player.playerId === 'alice-session'
                    ? { ...player, escaped: true, relicIds: [], score: 15 }
                    : player
            ),
            relics: [{ id: 'coin', name: 'Coin', value: 10, roomId: 'exit', foundBy: 'alice-session', escapedBy: 'alice-session' }]
        };
        const result = requireRelicCommandApplied(applyRelicCommand(previous, {
            ...command,
            username: 'Bob',
            kind: 'leave-expedition'
        }, { senderId: 'bob-session', now: 20, presentPlayerIds: ['bob-session'] })).state;
        expect(result.phase).toBe('finished');
        expect(result.players.map((player) => [player.playerId, player.score])).toEqual([['alice-session', 15]]);
        expect(result.winnerIds).toEqual(['alice-session']);
        expect(result.relics).toEqual(previous.relics);
        expect(toRelicRoundTransitionEvent(previous, result)).toMatchObject({ transition: 'finished', phase: 'finished' });
    });
    it('retains banked score history without letting a withdrawn escaped Keeper act again', () => {
        const previous: RelicGameState = {
            ...expedition('review'),
            players: expedition().players.map((player) =>
                player.playerId === 'alice-session'
                    ? { ...player, escaped: true, relicIds: [], score: 15 }
                    : player
            ),
            relics: [{ id: 'coin', name: 'Coin', value: 10, roomId: 'exit', escapedBy: 'alice-session' }]
        };
        const left = requireRelicCommandApplied(applyRelicCommand(previous, {
            ...command,
            kind: 'leave-expedition'
        }, { senderId: 'alice-session', now: 20, presentPlayerIds: ['alice-session', 'bob-session'] })).state;
        expect(left.adminPlayerId).toBe('bob-session');
        expect(left.players[0]).toMatchObject({ playerId: 'alice-session', score: 15, escaped: true });
        expect(
            requireRelicCommandApplied(applyRelicCommand(left, {
                ...command,
                kind: 'leave-expedition'
            }, { senderId: 'alice-session', now: 21, presentPlayerIds: ['alice-session', 'bob-session'] })).state
        ).toEqual(left);
        for (const kind of ['take-keeper', 'join-expedition'] as const) {
            expect(
                applyRelicCommand(left, { ...command, kind }, {
                    senderId: 'alice-session',
                    now: 22,
                    presentPlayerIds: ['alice-session']
                }).left?.code
            ).toBe('hunter-withdrawn');
        }
    });
});
