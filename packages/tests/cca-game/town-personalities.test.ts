import { beforeEach, describe, expect, it } from 'vitest';
import { createPracticeState } from '../../../apps/cca-2d/src/practice-rules.ts';
import { witnessTownPlayer } from '../../../apps/cca-2d/src/town/owners.ts';
import { advanceTownPersonalities, triggerTownPersonalities } from '../../../apps/cca-2d/src/town/personalities/rules.ts';
import type { TownState, TownTickInput } from '../../../apps/cca-2d/src/town/state.ts';
import { TownRoutes } from '../../../apps/cca-2d/src/town/town-routes.ts';

let routes: TownRoutes;
beforeEach(() => {
    routes = new TownRoutes();
});

describe('grumpy town personalities', () => {
    it('a fresh bell prank pays once and distracts nearby witnesses without repeated dash farming', () => {
        const player = { ...createPracticeState(), x: -11, z: 0.2, dashTime: 0.2 };
        const town = { ...player.town, npcs: [{ ...player.town.npcs[0], x: -10, z: 0 }] };
        const input = { routes, town, player, now: 1, step: 1 / 60, dash: true };
        const first = tickPersonalities(input);
        expect(first.score).toBe(10);
        expect(first.mischief).toBe(1);
        expect(first.personalities[0].phase).toBe('reacting');
        expect(witnessTownPlayer({ town: first, now: input.now, player: { ...player, id: 'player', score: 0 } }).npcs[0].mode).toBe('watching');
        const repeated = tickPersonalities({ ...input, town: first, now: 1.1 });
        expect(repeated.score).toBe(10);
    });
    it('the cleaner removes real nearby mess, then burps after three loads without scoring ambient work', () => {
        const player = createPracticeState();
        let town: TownState = { ...player.town, patches: [1, 2, 3].map((id) => ({ id, x: -10, z: -5, kind: 'poop' as const, born: 0, expires: 30 })) };
        for (const now of [1, 2, 3]) {
            town = tickPersonalities({ routes, town, player, now, step: 1, dash: false });
        }
        expect(town.patches).toHaveLength(0);
        expect(town.personalities.find((resident) => resident.kind === 'cleaner')?.phase).toBe('reacting');
        expect(town.cleaned).toBe(3);
        expect(town.score).toBe(0);
    });
    it('reactions restore their props and return residents home after a bounded interval', () => {
        const player = { ...createPracticeState(), x: 13, z: -13, dashTime: 0.2 };
        let town = tickPersonalities({ routes, town: player.town, player, now: 1, step: 0.1, dash: true });
        expect(town.personalities[1].phase).toBe('reacting');
        for (let now = 1.1; now < 17; now += 0.1) {
            town = tickPersonalities({ routes, town, player: { ...player, dashTime: 0 }, now, step: 0.1, dash: false });
        }
        const gardener = town.personalities[1];
        expect(gardener.phase).toBe('idle');
        expect(Math.hypot(gardener.x - gardener.home.x, gardener.z - gardener.home.z)).toBeLessThan(0.3);
        expect(town.score).toBe(10);
    });
});

it.each(['silence', 'gardener', 'queue', 'cleaner', 'mayor', 'washer', 'watcher'])('%s has an accessible deliberate prank and a bounded reward', (kind) => {
    const initial = createPracticeState();
    const resident = initial.town.personalities.find((entry) => entry.kind === kind)!;
    const player = { ...initial, x: resident.prop.x, z: resident.prop.z - resident.prop.depth / 2 - 0.4, dashTime: 0.2 };
    const town = tickPersonalities({ routes, town: initial.town, player, now: 1, step: 1 / 60, dash: true });
    expect(town.score).toBe(10);
    const repeat = tickPersonalities({ routes, town, player, now: 1.1, step: 1 / 60, dash: true });
    expect(repeat.score).toBe(10);
    expect(repeat.personalities.find((entry) => entry.kind === kind)?.rewardAt).toBe(31);
});

function tickPersonalities(input: TownTickInput): TownState {
    return advanceTownPersonalities({ ...input, town: triggerTownPersonalities(input), players: [] });
}
