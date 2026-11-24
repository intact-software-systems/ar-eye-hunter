import { beforeEach, describe, expect, it } from 'vitest';
import { TownRoutes } from '../../../apps/cca-2d/src/town/town-routes.ts';

import { computePracticeTick, createPracticeState } from '../../../apps/cca-2d/src/practice-rules.ts';
import { computeTownCreaturesForPlayers } from '../../../apps/cca-2d/src/town/creatures/rules.ts';
import { computeTownSoilingActors, createCleanCoat } from '../../../apps/cca-2d/src/town/soiling.ts';
import type { TownPlayer, TownState, TownTickInput } from '../../../apps/cca-2d/src/town/state.ts';

interface CreatureEncounterResult {
    readonly town: TownState;
    readonly player: TownPlayer;
}

let routes: TownRoutes;
beforeEach(() => {
    routes = new TownRoutes();
});

function encounter(kind: 'bird' | 'dog' | 'cat'): TownTickInput {
    const player = { ...createPracticeState(), x: 21, z: -10 };
    const creature = player.town.creatures.find((creature) => creature.kind === kind)!;
    return {
        routes,
        player,
        town: { ...player.town, creatures: [{ ...creature, x: 21, z: -12, home: { x: 21, z: -12 }, until: 0 }] },
        now: 1,
        step: 1 / 60,
        dash: false
    };
}

describe('grumpy creature attacks', () => {
    it.each([['bird', 'poop'], ['dog', 'pee'], ['cat', 'puke']] as const)(
        '%s warns before %s, permits a dodge and leaves bounded slippery mess',
        (kind, stain) => {
            const input = encounter(kind);
            const warning = tickCreature(input);
            expect(warning.town.creatures[0].mode).toBe('warning');
            expect(warning.player.stain).toBe('clean');
            const hit = tickCreature({ ...input, ...warning, now: 2.1 });
            expect(hit.player.stain).toBe(stain);
            expect(hit.town.patches[0].kind).toBe(stain);
            expect(hit.town.score).toBe(0);
            const missed = tickCreature({ ...input, ...warning, player: { ...warning.player, x: 23.5 }, now: 2.1 });
            expect(missed.player.stain).toBe('clean');
            const sliding = computePracticeTick(
                { ...createPracticeState(), ...input.player, town: hit.town, elapsed: 2.1, vx: 3 },
                { x: 0, z: 0, dash: 0 },
                { seconds: 1 / 60, routes }
            );
            expect(sliding.slipping).toBe(true);
            const cleaned = soilActors({ ...input, ...hit, now: 13 });
            expect(cleaned.player.stain).toBe('clean');
            expect(cleaned.town.patches).toHaveLength(0);
        }
    );
    it('credits a provoked animal hitting a resident once, but never credits ambient attacks', () => {
        const input = encounter('dog');
        const npc = { ...input.town.npcs[0], x: 21, z: -10 };
        const warning = tickCreature({ ...input, town: { ...input.town, npcs: [npc] }, dash: true });
        const hit = tickCreature({ ...input, ...warning, now: 2.1 });
        expect(hit.town.score).toBe(10);
        expect(hit.town.heat).toBe(1);
        expect(hit.town.npcs[0].stain).toBe('pee');
        expect(hit.town.npcs[0].mode).toBe('cleaning');
        const repeated = tickCreature({
            ...input,
            ...hit,
            town: { ...hit.town, npcs: [npc], creatures: [{ ...hit.town.creatures[0], mode: 'warning', until: 2 }] },
            now: 3
        });
        expect(repeated.town.score).toBe(10);
        const ambient = tickCreature({
            ...input,
            ...warning,
            town: { ...warning.town, creatures: [{ ...warning.town.creatures[0], provokedUntil: 0 }] },
            now: 2.1
        });
        expect(ambient.town.npcs[0].stain).toBe('pee');
        expect(ambient.town.score).toBe(0);
    });
    it('solid stalls block both direct splashes and new ground mess when a route closes', () => {
        const input = encounter('cat');
        const player = { ...input.player, x: 5, z: 5 };
        const creature = { ...input.town.creatures[0], x: 5, z: 1, mode: 'warning' as const, aim: { x: 5, z: 5 }, until: 1 };
        const result = tickCreature({ ...input, player, town: { ...input.town, creatures: [creature] }, now: 2 });
        const contact = soilActors({ ...input, ...result, now: 2 });
        expect(contact.player.stain).toBe('clean');
        expect(result.town.patches).toHaveLength(0);
    });
    it('water washes stains and immunity prevents repeated mess stun', () => {
        const input = encounter('bird');
        const dirty = { ...input.player, stain: 'poop' as const, stainedUntil: 8, messImmuneUntil: 9 };
        const water = { id: 1, kind: 'water' as const, x: 21, z: -10, born: 0, expires: 10 };
        const washed = soilActors({ ...input, player: dirty, town: { ...input.town, patches: [water] } });
        expect(washed.player.stain).toBe('clean');
        const next = tickCreature({
            ...input,
            ...washed,
            town: { ...washed.town, creatures: [{ ...washed.town.creatures[0], mode: 'warning', aim: { x: 21, z: -10 }, until: 1 }] },
            now: 1.1
        });
        expect(next.player.stain).toBe('clean');
        expect(next.player.frozenUntil).toBe(0);
    });
    it('a provoked splash interrupts a police warning and leaves the officer temporarily distracted', () => {
        const input = encounter('bird');
        const guard = { ...createCleanCoat(), id: 0, x: 21, z: -10, mode: 'warning' as const, until: 2, target: 'player' as const, aim: { x: 21, z: -10 } };
        const warning = tickCreature({
            ...input,
            dash: true,
            town: { ...input.town, raid: { ...input.town.raid, phase: 'active', until: 20, guards: [guard] } }
        });
        const hit = tickCreature({ ...input, ...warning, now: 2.1 });
        expect(hit.town.raid.guards[0].stain).toBe('poop');
        expect(hit.town.raid.guards[0].mode).toBe('patrol');
        expect(hit.town.score).toBe(10);
        expect(hit.town.heat).toBe(0);
    });
});

function tickCreature(input: TownTickInput): CreatureEncounterResult {
    const result = computeTownCreaturesForPlayers({
        ...input,
        disturbances: [],
        players: [{ ...input.player, id: 'player', score: input.town.score, dash: input.dash }]
    });
    return { town: { ...result.town, score: result.players[0].score }, player: result.players[0] };
}

function soilActors(input: TownTickInput): CreatureEncounterResult {
    const result = computeTownSoilingActors(input, [input.player]);
    return { town: result.town, player: result.actors[0] };
}
