import { describe, expect, it } from 'vitest';
import { blocksShot } from '../../../packages/ar-eye-hunter/arena-layout.ts';
import { EMPTY_INPUT } from '../../../packages/ar-eye-hunter/arena-player-state.ts';
import {
    advanceTournamentArena,
    applyTournamentArenaInput,
    createTournamentArena,
    decodeTournamentArenaInput
} from '../../../packages/ar-eye-hunter/tournament-arena.ts';

const start = 1000;
const players = ['alice', 'bob'] as const;

function arena() {
    return createTournamentArena({ gameId: 'match-1', principalIds: players, seed: 7, startedAtEpochMs: start, durationMs: 60000 });
}

function input(sequence = 1) {
    return { sequence, yaw: 0, pitch: 0, controls: { ...EMPTY_INPUT } };
}

describe('AR Eye server-owned tournament simulation', () => {
    it('admits only the fixed two accounts and rejects old input sequences', () => {
        const state = arena();
        const accepted = applyTournamentArenaInput({ state: state, principalId: 'alice', input: input(), nowEpochMs: start });
        expect(accepted.accepted).toBe(true);
        expect(applyTournamentArenaInput({ state: accepted.state, principalId: 'alice', input: input(), nowEpochMs: start + 100 }).accepted).toBe(false);
        expect(applyTournamentArenaInput({ state: state, principalId: 'spectator', input: input(), nowEpochMs: start }).accepted).toBe(false);
        expect(state.players.map((player) => player.principalId)).toEqual(players);
    });

    it('moves by server elapsed time and native movement rules, never by a supplied position or delta', () => {
        const initial = arena();
        const command = { ...input(), controls: { ...EMPTY_INPUT, moveZ: 1, sprint: true } };
        const accepted = applyTournamentArenaInput({ state: initial, principalId: 'alice', input: command, nowEpochMs: start });
        const moved = advanceTournamentArena(accepted.state, start + 200);
        const before = initial.players[0].simulation.position;
        const after = moved.players[0].simulation.position;
        expect(Math.hypot(...after.map((value, index) => value - before[index]))).toBeGreaterThan(0);
        expect(Math.hypot(...after.map((value, index) => value - before[index]))).toBeLessThan(3);
        expect(advanceTournamentArena(moved, start + 200)).toEqual(moved);
        const expired = advanceTournamentArena(moved, start + 1000);
        const later = advanceTournamentArena(expired, start + 2000);
        expect(later.players[0].simulation.position).toEqual(expired.players[0].simulation.position);
    });

    it('advances target motion, bounds and bounty expiry with the native server clock', () => {
        const initial = arena();
        const boundary = Math.max(8, initial.arena.layout.halfSize - 2.5);
        const moving = {
            ...initial,
            arena: {
                ...initial.arena,
                targets: [
                    { ...initial.arena.targets[0], position: [0, 2, 0] as const, velocity: [2, 0, 0] as const },
                    {
                        ...initial.arena.targets[1],
                        position: [boundary - 0.01, 2, 0] as const,
                        velocity: [2, 0, 0] as const,
                        rarity: 'bounty' as const,
                        bountyUntilEpochMs: start + 49
                    }
                ]
            }
        };
        const advanced = advanceTournamentArena(moving, start + 50);
        expect(advanced.arena.targets[0].position).toEqual([0.1, 2, 0]);
        expect(advanced.arena.targets[1].position).toEqual([boundary, 2, 0]);
        expect(advanced.arena.targets[1].velocity).toEqual([-2, 0, 0]);
        expect(advanced.arena.targets[1].rarity).toBe('volatile');
        expect(moving.arena.targets[0].position).toEqual([0, 2, 0]);
    });

    it('derives a shot origin, weapon and score from server state and enforces native cooldown', () => {
        const initial = arena();
        const origin = initial.players[0].simulation.position;
        const target = initial.arena.targets.find((eye) => !blocksShot(initial.arena.layout, origin, eye.position));
        if (!target) {
            throw new Error('Expected a visible native target');
        }
        const [x, y, z] = target.position.map((value, index) => value - origin[index]);
        const command = { ...input(), yaw: Math.atan2(x, z), pitch: -Math.atan2(y, Math.hypot(x, z)), controls: { ...EMPTY_INPUT, fire: true } };
        const accepted = applyTournamentArenaInput({ state: initial, principalId: 'alice', input: command, nowEpochMs: start });
        const hit = advanceTournamentArena(accepted.state, start + 50);
        expect(hit.players[0].simulation.combat.score).toBeGreaterThan(0);
        expect(hit.players[1].simulation.combat.score).toBe(0);
        const cooldown = advanceTournamentArena(hit, start + 100);
        expect(cooldown.players[0].simulation.combat.score).toBe(hit.players[0].simulation.combat.score);
        expect(hit.arena.players[0].score).toBe(hit.players[0].simulation.combat.score);
    });

    it('finishes at the server deadline and freezes score despite later inputs', () => {
        let state = arena();
        while (state.simulatedAtEpochMs < start + 60000) {
            state = advanceTournamentArena(state, start + 60000);
        }
        expect(state.arena.match?.status).toBe('complete');
        expect(state.arena.match?.completedAtEpochMs).toBe(start + 60000);
        expect(state.arena.activeEvent?.headline).toBe('Arena match complete — final scores are ready');
        expect(state.players.map((player) => player.simulation.combat.score)).toEqual([0, 0]);
        expect(applyTournamentArenaInput({ state: state, principalId: 'alice', input: input(), nowEpochMs: start + 60000 }).accepted).toBe(false);
        expect(advanceTournamentArena(state, start + 999999)).toEqual(state);
    });

    it('does not award a shot on the exclusive match deadline', () => {
        const initial = arena();
        const origin = initial.players[0].simulation.position;
        const target = initial.arena.targets.find((eye) => !blocksShot(initial.arena.layout, origin, eye.position));
        if (!target) {
            throw new Error('Expected a visible native target');
        }
        const [x, y, z] = target.position.map((value, index) => value - origin[index]);
        const beforeDeadline = {
            ...initial,
            simulatedAtEpochMs: initial.endsAtEpochMs - 50,
            players: initial.players.map((player) => ({
                ...player,
                inputAtEpochMs: initial.endsAtEpochMs - 50,
                input: { ...input(), yaw: Math.atan2(x, z), pitch: -Math.atan2(y, Math.hypot(x, z)), controls: { ...EMPTY_INPUT, fire: true } }
            }))
        };
        const completed = advanceTournamentArena(beforeDeadline, initial.endsAtEpochMs);
        expect(completed.players.map((player) => player.simulation.combat.score)).toEqual([0, 0]);
        expect(completed.arena.match?.status).toBe('complete');
    });

    it('does not resurrect a player or let them shoot after an earlier shot eliminated them in the same tick', () => {
        const initial = arena();
        const duel = {
            ...initial,
            arena: { ...initial.arena, targets: [] },
            players: initial.players.map((player, index) => ({
                ...player,
                simulation: {
                    ...player.simulation,
                    position: [0, 1.72, index * 5] as const,
                    vitals: { ...player.simulation.vitals, health: index === 0 ? 100 : 1 }
                },
                input: { ...input(), yaw: index === 0 ? 0 : Math.PI, controls: { ...EMPTY_INPUT, fire: true } }
            }))
        };
        const after = advanceTournamentArena(duel, start + 50);
        expect(after.players[0].simulation.vitals.health).toBe(100);
        expect(after.players[1].simulation.vitals.health).toBe(0);
        expect(after.players[1].simulation.vitals.deaths).toBe(1);
    });

    it('uses native spawn points when a defeated player respawns', () => {
        const initial = arena();
        const vitals = { ...initial.players[0].simulation.vitals, health: 0, deaths: 1, deadUntilEpochMs: start + 50 };
        const defeated = {
            ...initial,
            arena: {
                ...initial.arena,
                players: initial.arena.players.map((player, index) => index === 0 ? { ...player, position: [0, 1.72, 0] as const, vitals } : player)
            },
            players: initial.players.map((player, index) =>
                index === 0 ? { ...player, simulation: { ...player.simulation, position: [0, 1.72, 0] as const, vitals } } : player
            )
        };
        const revived = advanceTournamentArena(defeated, start + 50);
        expect(revived.players[0].simulation.vitals.health).toBe(100);
        expect(revived.arena.layout.spawnPoints).toContainEqual(revived.players[0].simulation.position);
    });

    it.each([
        { score: 99999 },
        { position: [0, 0, 0] },
        { dtMs: 100000 },
        { origin: [0, 0, 0] },
        { weaponKind: 'rail-lance' },
        { sequence: -1 },
        { sequence: 0 },
        { yaw: Infinity },
        { pitch: Math.PI },
        { controls: { ...EMPTY_INPUT, moveX: 100 } },
        { controls: { ...EMPTY_INPUT, fire: 'yes' } },
        { controls: { ...EMPTY_INPUT, health: 10000 } }
    ])('rejects forged or malformed command fields: %j', (change) => {
        expect(() => decodeTournamentArenaInput({ ...input(), ...change })).toThrow();
    });
});
