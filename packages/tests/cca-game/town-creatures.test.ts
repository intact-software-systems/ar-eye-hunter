import {
    describe,
    expect,
    it
} from 'vitest';

import { computePracticeTick, createPracticeState } from '../../../apps/cca-2d/src/practice-rules.ts';
import { computeTownCreatures } from '../../../apps/cca-2d/src/town/creatures/rules.ts';
import { computeTownSoiling, createCleanCoat } from '../../../apps/cca-2d/src/town/soiling.ts';
import type { TownTickInput } from '../../../apps/cca-2d/src/town/state.ts';

function encounter(kind: 'bird' | 'dog' | 'cat'): TownTickInput {
    const player = { ...createPracticeState(), x: 18, z: -18 };
    const creature = player.town.creatures.find((creature) => creature.kind === kind)!;
    return {
        player,
        town: { ...player.town, creatures: [{ ...creature, x: 18, z: -20, home: { x: 18, z: -20 }, until: 0 }] },
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
            const warning = computeTownCreatures(input);
            expect(warning.town.creatures[0].mode).toBe('warning');
            expect(warning.player.stain).toBe('clean');
            const hit = computeTownCreatures({ ...input, ...warning, now: 2.1 });
            expect(hit.player.stain).toBe(stain);
            expect(hit.town.patches[0].kind).toBe(stain);
            expect(hit.town.score).toBe(0);
            const missed = computeTownCreatures({ ...input, ...warning, player: { ...warning.player, x: 21 }, now: 2.1 });
            expect(missed.player.stain).toBe('clean');
            const sliding = computePracticeTick(
                { ...createPracticeState(), ...input.player, town: hit.town, elapsed: 2.1, vx: 3 },
                { x: 0, z: 0, dash: 0 },
                1 / 60
            );
            expect(sliding.slipping).toBe(true);
            const cleaned = computeTownSoiling({ ...input, ...hit, now: 13 });
            expect(cleaned.player.stain).toBe('clean');
            expect(cleaned.town.patches).toHaveLength(0);
        }
    );
    it('credits a provoked animal hitting a resident once, but never credits ambient attacks', () => {
        const input = encounter('dog');
        const npc = { ...input.town.npcs[0], x: 18, z: -18 };
        const warning = computeTownCreatures({ ...input, town: { ...input.town, npcs: [npc] }, dash: true });
        const hit = computeTownCreatures({ ...input, ...warning, now: 2.1 });
        expect(hit.town.score).toBe(10);
        expect(hit.town.heat).toBe(1);
        expect(hit.town.npcs[0].stain).toBe('pee');
        expect(hit.town.npcs[0].mode).toBe('cleaning');
        const repeated = computeTownCreatures({
            ...input,
            ...hit,
            town: { ...hit.town, npcs: [npc], creatures: [{ ...hit.town.creatures[0], mode: 'warning', until: 2 }] },
            now: 3
        });
        expect(repeated.town.score).toBe(10);
        const ambient = computeTownCreatures({
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
        const result = computeTownCreatures({ ...input, player, town: { ...input.town, creatures: [creature] }, now: 2 });
        const contact = computeTownSoiling({ ...input, ...result, now: 2 });
        expect(contact.player.stain).toBe('clean');
        expect(result.town.patches).toHaveLength(0);
    });
    it('water washes stains and immunity prevents repeated mess stun', () => {
        const input = encounter('bird');
        const dirty = { ...input.player, stain: 'poop' as const, stainedUntil: 8, messImmuneUntil: 9 };
        const water = { id: 1, kind: 'water' as const, x: 18, z: -18, born: 0, expires: 10 };
        const washed = computeTownSoiling({ ...input, player: dirty, town: { ...input.town, patches: [water] } });
        expect(washed.player.stain).toBe('clean');
        const next = computeTownCreatures({
            ...input,
            ...washed,
            town: { ...washed.town, creatures: [{ ...washed.town.creatures[0], mode: 'warning', aim: { x: 18, z: -18 }, until: 1 }] },
            now: 1.1
        });
        expect(next.player.stain).toBe('clean');
        expect(next.player.frozenUntil).toBe(0);
    });
    it('a provoked splash interrupts a police warning and leaves the officer temporarily distracted', () => {
        const input = encounter('bird');
        const guard = { ...createCleanCoat(), id: 0, x: 18, z: -18, mode: 'warning' as const, until: 2, target: 'player' as const, aim: { x: 18, z: -18 } };
        const warning = computeTownCreatures({
            ...input,
            dash: true,
            town: { ...input.town, raid: { ...input.town.raid, phase: 'active', until: 20, guards: [guard] } }
        });
        const hit = computeTownCreatures({ ...input, ...warning, now: 2.1 });
        expect(hit.town.raid.guards[0].stain).toBe('poop');
        expect(hit.town.raid.guards[0].mode).toBe('patrol');
        expect(hit.town.score).toBe(10);
        expect(hit.town.heat).toBe(0);
    });
});
