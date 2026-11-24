import { describe, expect, it } from 'vitest';

import { createPracticePlayer } from '../../../apps/cca-2d/src/practice-rules.ts';
import { computeTownWorld } from '../../../apps/cca-2d/src/town/rules.ts';
import { createCleanCoat } from '../../../apps/cca-2d/src/town/soiling.ts';
import { createTownState, type TownWorldPlayer } from '../../../apps/cca-2d/src/town/state.ts';
import { TownRoutes } from '../../../apps/cca-2d/src/town/town-routes.ts';

function player(id: string): TownWorldPlayer {
    return {
        ...createPracticePlayer(),
        id,
        dash: false,
        score: 0,
        rescues: 0,
        rescueTarget: undefined,
        rescueProgress: 0,
        rewardedThisRaid: false
    };
}

function world() {
    return { ...createTownState(), companion: undefined };
}

describe('one shared town tick', () => {
    it('a barbecue witness follows the culprit through roster reorder and returns when that player leaves', () => {
        const initial = world();
        const town = {
            ...initial,
            personalities: [{
                ...initial.personalities[0],
                x: -13,
                z: -11,
                home: { x: -13, z: -11 }
            }]
        };
        const alice = { ...player('alice'), x: -14, z: -9.6, dash: true, dashTime: 0.2 };
        const bob = { ...player('bob'), x: -11, z: -11 };
        const input = { town, players: [alice, bob], now: 1, step: 1 / 30, routes: new TownRoutes() };
        const fire = computeTownWorld(input);
        expect(fire.town.personalities[0].targetId).toBe('alice');
        const reordered = computeTownWorld({ ...input, town: fire.town, now: 1.1, players: [bob, { ...alice, x: -14, z: -10.4, dash: false, dashTime: 0 }] });
        expect(reordered.town.personalities[0].phase).toBe('chasing');
        expect(reordered.town.personalities[0].target).toEqual({ x: -14, z: -10.4 });
        const departed = computeTownWorld({ ...input, town: reordered.town, players: [bob], now: 1.2 });
        expect(departed.town.personalities[0].phase).toBe('returning');
        expect(departed.town.personalities[0].target).not.toEqual({ x: bob.x, z: bob.z });
    });

    it('credits separate pranks to their authors and resolves a contested source once in stable identity order', () => {
        const town = world();
        const alice = { ...player('alice'), x: 5, z: 1.35, facingX: 0, facingZ: 1, dash: true, dashTime: 0.2 };
        const bob = { ...player('bob'), x: -5, z: 1.35, facingX: 0, facingZ: 1, dash: true, dashTime: 0.2 };
        const input = { town, players: [alice, bob], now: 1, step: 1 / 30, routes: new TownRoutes() };
        const result = computeTownWorld(input);
        expect(result.town.spills).toBe(2);
        expect(result.players.map((actor) => actor.score)).toEqual([10, 10]);
        expect(result.town.fruit).toHaveLength(12);
        expect(town.spills).toBe(0);
        const contested = computeTownWorld({ ...input, players: [{ ...alice, id: 'bob' }, alice] });
        expect(contested.town.spills).toBe(1);
        expect(contested.players.find((actor) => actor.id === 'alice')?.score).toBe(10);
        expect(contested.players.find((actor) => actor.id === 'bob')?.score).toBe(0);
    });

    it('advances debris, cleanup, residents and fire response once independent of roster size', () => {
        const initial = world();
        const town = {
            ...initial,
            fountain: { ...initial.fountain, broken: true },
            npcs: [{ ...initial.npcs[0], x: 0, z: 6 }],
            fruit: [{ id: 1, shopId: 'pears', x: 10, z: -3, vx: 3, vz: 0, born: 0 }],
            spectacles: {
                ...initial.spectacles,
                active: {
                    kind: 'fire' as const,
                    phase: 'active' as const,
                    origin: { x: -14, z: -8.5 },
                    witnesses: [],
                    startedAt: 0,
                    until: 100,
                    progress: 0,
                    nextPatchAt: 0
                },
                firefighters: [{ ...createCleanCoat(), id: 0, x: -14, z: -10.5, phase: 'responding' as const, until: 0, aim: { x: -14, z: -8.5 } }]
            },
            nextId: 2
        };
        const alice = { ...player('alice'), x: 20, z: -18 };
        const input = { town, players: [alice], now: 1, step: 1 / 30, routes: new TownRoutes() };
        const alone = computeTownWorld(input);
        const together = computeTownWorld({ ...input, players: [alice, { ...alice, id: 'bob' }] });
        expect(together.town.fruit).toEqual(alone.town.fruit);
        expect(together.town.fruit[0].x).toBeCloseTo(10.1);
        expect(together.town.fountain.repair).toBeCloseTo(1 / 30);
        expect(together.town.npcs).toEqual(alone.town.npcs);
        expect(together.town.personalities).toEqual(alone.town.personalities);
        expect(together.town.spectacles).toEqual(alone.town.spectacles);
        expect(together.town.spectacles.firefighters[0].x).toBeCloseTo(-14.14);
        expect(together.town.companion).toBeUndefined();
    });

    it('shares pickup cooldowns and splashes every exposed human when one bomb bursts', () => {
        const alice = { ...player('alice'), x: 3, z: -12 };
        const bob = { ...alice, id: 'bob' };
        const input = { town: world(), players: [bob, alice], now: 1, step: 1 / 30, routes: new TownRoutes() };
        const picked = computeTownWorld(input);
        expect(picked.players.find((actor) => actor.id === 'alice')?.power).toBe('poop-bomb');
        expect(picked.players.find((actor) => actor.id === 'bob')?.power).toBe('fart');
        const armed = computeTownWorld({
            ...input,
            town: picked.town,
            now: 2,
            players: picked.players.map((actor) => ({ ...actor, dash: actor.id === 'alice' }))
        });
        expect(armed.players.find((actor) => actor.id === 'alice')?.score).toBe(20);
        expect(armed.players.find((actor) => actor.id === 'bob')?.score).toBe(0);
        const burst = computeTownWorld({
            ...input,
            town: armed.town,
            now: 4.1,
            players: armed.players.map((actor) => ({ ...actor, dash: false }))
        });
        expect(burst.players.every((actor) => actor.stain === 'poop')).toBe(true);
        expect(burst.town.spectacles.bombs).toBe(1);
        expect(burst.town.patches.length).toBeLessThanOrEqual(12);
    });

    it('a reflected café stream hits both exposed players while preserving washing immunity', () => {
        const initial = world();
        const town = {
            ...initial,
            spectacles: {
                ...initial.spectacles,
                umbrellaUntil: 8,
                active: {
                    kind: 'vomit' as const,
                    phase: 'warning' as const,
                    origin: { x: -12, z: -3.5 },
                    witnesses: [],
                    startedAt: 1,
                    until: 3,
                    progress: 0,
                    nextPatchAt: 3
                }
            }
        };
        const result = computeTownWorld({
            town,
            routes: new TownRoutes(),
            now: 3.1,
            step: 1 / 30,
            players: [
                { ...player('alice'), x: -6, z: -1 },
                { ...player('bob'), x: -7, z: -1 },
                { ...player('carol'), x: -6.5, z: -1, messImmuneUntil: 8 }
            ]
        });
        expect(result.players.map((actor) => actor.stain)).toEqual(['puke', 'puke', 'clean']);
        expect(result.town.spectacles.dinners).toBe(1);
        expect(result.town.patches).toHaveLength(2);
        expect(result.town.spectacles.active?.until).toBe(9.1);
    });

    it('rescues a real friend without a bot and awards a shared raid milestone once', () => {
        const alice = { ...player('alice'), frozenUntil: 6 };
        const bob = { ...player('bob'), x: 0.5, rescueTarget: 'alice', rescueProgress: 0.99 };
        const input = { town: world(), players: [alice, bob], now: 1, step: 1 / 30, routes: new TownRoutes() };
        const rescued = computeTownWorld(input);
        expect(rescued.players[0].frozenUntil).toBe(0);
        expect(rescued.players[0].shieldUntil).toBe(3.5);
        expect(rescued.players[1].rescues).toBe(1);
        expect(rescued.players[1].score).toBe(3);
        const alarm = computeTownWorld({ ...input, ...rescued, town: { ...rescued.town, heat: 6 }, now: 2 });
        expect(alarm.players.map((actor) => actor.score)).toEqual([50, 53]);
        expect(alarm.players.every((actor) => !actor.rewardedThisRaid)).toBe(true);
        expect(alarm.town.raid.phase).toBe('alarm');
        const repeated = computeTownWorld({ ...input, ...alarm, now: 2.1 });
        expect(repeated.players.map((actor) => actor.score)).toEqual([50, 53]);
        expect(repeated.town.raid.bonuses).toBe(1);
    });
});
