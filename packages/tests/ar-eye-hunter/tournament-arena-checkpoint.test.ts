import { decodeTournamentArenaCheckpoint } from '@ar-eye-hunter/decode-tournament-arena-checkpoint.ts';
import { advanceTournamentArena, createTournamentArena } from '@ar-eye-hunter/tournament-arena.ts';
import { describe, expect, it } from 'vitest';

const identity = { gameId: 'match-1', principalIds: ['alice', 'bob'] as const, startedAtEpochMs: 1000, durationMs: 60000 as const, seed: 7 };

function checkpoint() {
    return JSON.parse(JSON.stringify(advanceTournamentArena(createTournamentArena(identity), 1500)));
}

describe('AR Eye authoritative checkpoint integrity', () => {
    it('restores a checkpoint without changing deterministic continuation', () => {
        const state = advanceTournamentArena(createTournamentArena(identity), 1500);
        const restored = decodeTournamentArenaCheckpoint(checkpoint(), identity);
        expect(advanceTournamentArena(restored, 2000)).toEqual(advanceTournamentArena(state, 2000));
    });

    it.each([
        { gameId: 'other' },
        { startedAtEpochMs: 0 },
        { endsAtEpochMs: 61001 },
        { simulatedAtEpochMs: 1501 },
        { simulatedAtEpochMs: 999 },
        { simulatedAtEpochMs: 62000 },
        { players: [] },
        { extra: 'unexpected' }
    ])('rejects malformed identity, clocks or roster: %j', (change) => {
        expect(() => decodeTournamentArenaCheckpoint({ ...checkpoint(), ...change }, identity)).toThrow();
    });

    it.each(['principal', 'score', 'health', 'position', 'input', 'target', 'wave', 'match', 'layout', 'attack', 'event'])(
        'rejects malformed nested %s instead of repairing it',
        (field) => {
            const stored = checkpoint();
            switch (field) {
                case 'principal':
                    stored.players[0].principalId = 'mallory';
                    break;
                case 'score':
                    stored.players[0].simulation.combat.score = '999';
                    break;
                case 'health':
                    stored.players[0].simulation.vitals.health = -1;
                    break;
                case 'position':
                    stored.players[0].simulation.position = [0, 0];
                    break;
                case 'input':
                    stored.players[0].input.controls.moveZ = 999;
                    break;
                case 'target':
                    stored.arena.targets[0].health = null;
                    break;
                case 'wave':
                    delete stored.arena.wave.nextPhaseAtEpochMs;
                    break;
                case 'match':
                    stored.arena.match.matchId = 'old-match';
                    break;
                case 'layout':
                    stored.arena.layout.halfSize = 9999;
                    break;
                case 'attack':
                    stored.arena.attacks = [{ id: 'forged' }];
                    break;
                case 'event':
                    stored.arena.events[0].kind = 'unknown';
                    break;
            }
            expect(() => decodeTournamentArenaCheckpoint(stored, identity)).toThrow();
        }
    );

    it('refuses mismatched player projection and completion before the authorized deadline', () => {
        const wrongProjection = checkpoint();
        wrongProjection.arena.players[0].score += 10;
        expect(() => decodeTournamentArenaCheckpoint(wrongProjection, identity)).toThrow();
        const earlyFinish = checkpoint();
        earlyFinish.arena.match.status = 'complete';
        expect(() => decodeTournamentArenaCheckpoint(earlyFinish, identity)).toThrow();
    });
});
