import { describe, expect, it } from 'vitest';

import { createPracticePlayer } from '../../../apps/grumpy-town/src/practice-rules.ts';
import { computeTownGuard } from '../../../apps/grumpy-town/src/town/authorities.ts';
import { computeTownRescues, type TownRescueActor } from '../../../apps/grumpy-town/src/town/companion.ts';
import { computeTownCreaturesForPlayers } from '../../../apps/grumpy-town/src/town/creatures/rules.ts';
import { computeTownOwnersForPlayers, witnessTownPlayer } from '../../../apps/grumpy-town/src/town/owners.ts';
import { createCleanCoat } from '../../../apps/grumpy-town/src/town/soiling.ts';
import { createTownState, type TownGuard } from '../../../apps/grumpy-town/src/town/state.ts';
import { TownRoutes } from '../../../apps/grumpy-town/src/town/town-routes.ts';

describe('police targeting a human roster', () => {
    it('locks a warning to the nearest available identity and cannot hit another player after roster reorder', () => {
        const initial = createTownState();
        const town = { ...initial, raid: { ...initial.raid, phase: 'active' as const, until: 10 } };
        const guard: TownGuard = {
            ...createCleanCoat(),
            id: 0,
            x: 0,
            z: -4,
            mode: 'patrol',
            target: 'none',
            aim: { x: 0, z: -2 },
            until: 0
        };
        const targets = [
            { ...createPracticePlayer(), id: 'alice', x: 0, z: -2 },
            { ...createPracticePlayer(), id: 'bob', x: 0, z: -3, shieldUntil: 10 },
            { ...createPracticePlayer(), id: 'carol', x: 2, z: -3 }
        ];
        const input = { town, guard, targets, routes: new TownRoutes(), now: 1, step: 1 / 30 };
        const warning = computeTownGuard(input);
        expect(warning.guard.mode).toBe('warning');
        expect(warning.guard.target).toBe('alice');
        const hit = computeTownGuard({ ...input, guard: warning.guard, targets: [...targets].reverse(), now: 2 });
        expect(hit.frozenTarget).toBe('alice');
        const departed = computeTownGuard({ ...input, guard: warning.guard, targets: targets.slice(1), now: 2 });
        expect(departed.frozenTarget).toBeUndefined();
        expect(departed.guard.mode).toBe('cooldown');
    });
});

function rescueActor(id: string, x: number): TownRescueActor {
    return {
        id,
        x,
        z: -2,
        frozenUntil: 0,
        shieldUntil: 0,
        dashTime: 0,
        rescueTarget: undefined,
        rescueProgress: 0,
        rescues: 0,
        score: 0,
        rewardedThisRaid: false
    };
}

describe('human proximity rescues', () => {
    it('credits one rescuer when two friends finish together and protects the rescued player', () => {
        const actors = [
            { ...rescueActor('alice', 0), frozenUntil: 6 },
            { ...rescueActor('bob', 0.5), rescueTarget: 'alice', rescueProgress: 0.99 },
            { ...rescueActor('carol', -0.5), rescueTarget: 'alice', rescueProgress: 0.99 }
        ];
        const rescued = computeTownRescues({ town: createTownState(), actors, now: 2, step: 1 / 30 });
        expect(rescued[0].frozenUntil).toBe(0);
        expect(rescued[0].shieldUntil).toBe(4.5);
        expect(rescued.reduce((sum, actor) => sum + actor.rescues, 0)).toBe(1);
        expect(rescued.reduce((sum, actor) => sum + actor.score, 0)).toBe(3);
        expect(actors[0].frozenUntil).toBe(6);
        expect(rescued.every((actor) => actor.rescueProgress === 0)).toBe(true);
    });

    it('resets progress when switching friends and does not farm the same raid bonus', () => {
        const actors = [
            { ...rescueActor('alice', 0), rescueTarget: 'departed', rescueProgress: 0.99, rewardedThisRaid: true },
            { ...rescueActor('bob', 0.5), frozenUntil: 6 }
        ];
        const input = { town: createTownState(), actors, now: 2, step: 1 / 30 };
        const changed = computeTownRescues(input);
        expect(changed[0].rescueProgress).toBeCloseTo(1 / 30);
        expect(changed[1].frozenUntil).toBe(6);
        const completed = computeTownRescues({ ...input, actors: [{ ...changed[0], rescueProgress: 0.99 }, changed[1]] });
        expect(completed[0].rescues).toBe(1);
        expect(completed[0].score).toBe(0);
        expect(completed[1].frozenUntil).toBe(0);
    });
});

describe('shopkeepers in a shared town', () => {
    it('remembers the witnessed culprit and penalizes only that identity after roster reorder', () => {
        const initial = createTownState();
        const town = { ...initial, npcs: [{ ...initial.npcs[0], x: 0, z: -4 }] };
        const alice = { ...createPracticePlayer(), id: 'alice', score: 10, x: 0, z: -2 };
        const bob = { ...createPracticePlayer(), id: 'bob', score: 20, x: 0.2, z: -2 };
        const witnessed = witnessTownPlayer({ town, player: alice, now: 1 });
        expect(witnessed.npcs[0].targetId).toBe('alice');
        const input = { routes: new TownRoutes(), town: witnessed, players: [bob, alice], now: 2, step: 1 / 30 };
        const warning = computeTownOwnersForPlayers(input);
        expect(warning.town.npcs[0].mode).toBe('warning');
        const hit = computeTownOwnersForPlayers({ ...input, ...warning, now: 3 });
        expect(hit.players.find((player) => player.id === 'alice')?.score).toBe(7);
        expect(hit.players.find((player) => player.id === 'bob')?.score).toBe(20);
        expect(hit.players.find((player) => player.id === 'alice')?.shieldUntil).toBe(5);
        expect(town.npcs[0].mode).toBe('watching');

        const departed = computeTownOwnersForPlayers({ ...input, town: warning.town, players: [bob], now: 3 });
        expect(departed.players[0].score).toBe(20);
        expect(departed.town.npcs[0].mode).toBe('watching');
        expect(departed.town.npcs[0].targetId).toBeUndefined();
    });

    it('advances a shopkeeper cleanup once regardless of the number of players', () => {
        const initial = createTownState();
        const town = {
            ...initial,
            fountain: { ...initial.fountain, broken: true },
            npcs: [{ ...initial.npcs[0], x: 0, z: 6 }]
        };
        const alice = { ...createPracticePlayer(), id: 'alice', score: 10 };
        const input = { town, routes: new TownRoutes(), players: [alice], now: 1, step: 1 / 30 };
        const alone = computeTownOwnersForPlayers(input);
        const together = computeTownOwnersForPlayers({ ...input, players: [alice, { ...alice, id: 'bob' }] });
        expect(together.town.npcs).toEqual(alone.town.npcs);
        expect(together.town.fountain).toEqual(alone.town.fountain);
        expect(together.town.fountain.repair).toBeCloseTo(1 / 30);
        expect(together.players.map((player) => player.score)).toEqual([10, 10]);
        expect(town.fountain.repair).toBe(0);
    });
});

describe('creatures in a shared town', () => {
    it('splashes every exposed player once and credits the provoker rather than the nearest victim', () => {
        const initial = createTownState();
        const town = {
            ...initial,
            npcs: [{ ...initial.npcs[0], x: 0, z: -3 }],
            creatures: [{ ...initial.creatures[0], x: 0, z: -4, home: { x: 0, z: -4 }, until: 0 }]
        };
        const players = [
            { ...createPracticePlayer(), id: 'alice', score: 0, dash: true, x: 0, z: -2 },
            { ...createPracticePlayer(), id: 'bob', score: 0, dash: false, x: 0, z: -3 }
        ];
        const input = { town, players, disturbances: [], routes: new TownRoutes(), now: 1, step: 1 / 30 };
        const warning = computeTownCreaturesForPlayers(input);
        expect(warning.town.creatures[0].aim).toEqual({ x: 0, z: -3 });
        expect(warning.town.creatures[0].provokerId).toBe('alice');
        const hit = computeTownCreaturesForPlayers({
            ...input,
            ...warning,
            players: warning.players.toReversed().map((player) => ({ ...player, dash: false })),
            now: 2
        });
        expect(hit.players.every((player) => player.stain === 'poop')).toBe(true);
        expect(hit.players.find((player) => player.id === 'alice')?.score).toBe(10);
        expect(hit.players.find((player) => player.id === 'bob')?.score).toBe(0);
        expect(hit.town.creatures[0].attacks).toBe(1);
        expect(hit.town.patches).toHaveLength(1);
        expect(hit.town.mischief).toBe(1);
        expect(town.creatures[0].attacks).toBe(0);

        const departed = computeTownCreaturesForPlayers({
            ...input,
            town: warning.town,
            players: [players[1]],
            now: 2
        });
        expect(departed.players[0].stain).toBe('poop');
        expect(departed.players[0].score).toBe(0);
        expect(departed.town.mischief).toBe(0);
    });
});
