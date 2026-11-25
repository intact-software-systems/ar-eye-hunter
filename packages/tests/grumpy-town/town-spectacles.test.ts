import { beforeEach, describe, expect, it } from 'vitest';
import { createPracticeState } from '../../../apps/grumpy-town/src/practice-rules.ts';
import { collectTownPickup, releaseTownPrank } from '../../../apps/grumpy-town/src/town/pranks.ts';
import { advanceTownSpectacles, requestTownSpectacle, triggerTownSpectacles } from '../../../apps/grumpy-town/src/town/spectacles/rules.ts';
import { TownRoutes } from '../../../apps/grumpy-town/src/town/town-routes.ts';

import type { TownPlayer, TownState, TownTickInput } from '../../../apps/grumpy-town/src/town/state.ts';

interface SpectacleEncounterResult {
    readonly town: TownState;
    readonly player: TownPlayer;
}

let routes: TownRoutes;
beforeEach(() => {
    routes = new TownRoutes();
});

describe('major town spectacles', () => {
    it('fire pays once, dispatches a crew and records only nearby visible witnesses', () => {
        const player = { ...createPracticeState(), x: -14, z: -9.6, dashTime: 0.2 };
        const npcs = [{ ...player.town.npcs[0], x: -13, z: -11 }, { ...player.town.npcs[1], x: -19, z: 0 }];
        const input = { routes, town: { ...player.town, npcs }, player, now: 1, step: 1 / 60, dash: true };
        const first = tickSpectacle(input);
        expect(first.town.score).toBe(20);
        expect(first.town.mischief).toBe(1);
        expect(first.town.spectacles.active?.kind).toBe('fire');
        expect(first.town.spectacles.active?.witnesses).toContain('apples');
        expect(first.town.spectacles.active?.witnesses).not.toContain('pears');
        const repeat = tickSpectacle({ ...input, town: first.town, now: 1.1 });
        expect(repeat.town.score).toBe(20);
        expect(repeat.town.spectacles.firefighters).toHaveLength(2);
    });
    it('the bomb uses dash, has a countdown and hits a large radius while respecting solid cover', () => {
        const player = { ...createPracticeState(), x: 3, z: -12 };
        const pickup = collectTownPickup(player.town, player, 0);
        expect(pickup.power).toBe('poop-bomb');
        const dropped = releaseTownPrank(pickup.town, { ...player, x: 6, power: pickup.power }, 1);
        const armed = tickSpectacle({ routes, town: dropped, player, now: 1, step: 1 / 60, dash: false });
        expect(armed.player.stain).toBe('clean');
        const bystanders = [{ ...player.town.npcs[0], x: 3, z: -12 }, { ...player.town.npcs[1], x: 9, z: -7 }];
        const burst = tickSpectacle({ routes, town: { ...armed.town, npcs: bystanders }, player, now: 3.1, step: 1 / 60, dash: false });
        expect(burst.player.stain).toBe('poop');
        expect(burst.town.npcs[0].stain).toBe('poop');
        expect(burst.town.npcs[1].stain).toBe('clean');
        expect(burst.town.patches.length).toBeGreaterThan(4);
        expect(burst.town.patches.length).toBeLessThanOrEqual(12);
        expect(burst.town.mischief).toBe(1);
    });
    it('queued spectacles retain their consequence and cannot duplicate one kind', () => {
        const player = createPracticeState();
        let town = requestTownSpectacle(player.town, { kind: 'fire', origin: { x: -14, z: -8.5 }, witnesses: [] });
        town = requestTownSpectacle(town, { kind: 'poop', origin: { x: 2, z: -2 }, witnesses: [] });
        town = requestTownSpectacle(town, { kind: 'vomit', origin: { x: -12, z: -3.5 }, witnesses: [] });
        town = requestTownSpectacle(town, { kind: 'poop', origin: { x: 3, z: -3 }, witnesses: [] });
        expect(town.score).toBe(60);
        expect(town.spectacles.queue).toHaveLength(3);
        for (let now = 1; now < 80; now += 1 / 30) {
            town = tickSpectacle({ routes, town, player, now, step: 1 / 30, dash: false }).town;
        }
        expect(town.spectacles.active).toBeUndefined();
        expect(town.spectacles.queue).toHaveLength(0);
        expect(town.spectacles.firefighters).toHaveLength(0);
        expect(town.spectacles.bombs).toBe(1);
        expect(town.spectacles.dinners).toBe(1);
    });
});

it('the crew visibly warns, extinguishes by spraying and returns without the timeout fallback', () => {
    const player = { ...createPracticeState(), x: -14, z: -9.6, dashTime: 0.2 };
    let town = player.town;
    let warned = false;
    let extinguished = false;
    for (let now = 0; now < 30; now += 1 / 30) {
        town = tickSpectacle({ routes, town, player: { ...player, dashTime: now < 0.1 ? 0.2 : 0 }, now, step: 1 / 30, dash: now === 0 }).town;
        warned ||= town.spectacles.firefighters.some((crew) => crew.phase === 'aiming');
        if (town.spectacles.active?.phase === 'cleanup') {
            extinguished ||= town.spectacles.active.progress >= 5;
        }
    }
    expect(warned).toBe(true);
    expect(extinguished).toBe(true);
    expect(town.spectacles.active).toBeUndefined();
    expect(town.spectacles.firefighters).toHaveLength(0);
});

it('the café warns before spraying, the umbrella changes who is hit, and the incident cleans up', () => {
    const player = { ...createPracticeState(), x: -12, z: -3, dashTime: 0.2 };
    const warning = tickSpectacle({ routes, town: player.town, player, now: 1, step: 1 / 60, dash: true });
    expect(warning.town.spectacles.active?.phase).toBe('warning');
    expect(warning.town.score).toBe(20);
    const bystander = { ...player, x: -6, z: -1, dashTime: 0 };
    const redirected = tickSpectacle({
        routes,
        town: { ...warning.town, spectacles: { ...warning.town.spectacles, umbrellaUntil: 8 } },
        player: bystander,
        now: 3.1,
        step: 1 / 60,
        dash: false
    });
    expect(redirected.player.stain).toBe('puke');
    const ordinary = tickSpectacle({ routes, town: warning.town, player: bystander, now: 3.1, step: 1 / 60, dash: false });
    expect(ordinary.player.stain).toBe('clean');
    let town = redirected.town;
    for (let now = 3.2; now < 18; now += 0.1) {
        town = tickSpectacle({ routes, town, player: bystander, now, step: 0.1, dash: false }).town;
    }
    expect(town.spectacles.active).toBeUndefined();
    expect(town.score).toBe(20);
});

function tickSpectacle(input: TownTickInput): SpectacleEncounterResult {
    const town = triggerTownSpectacles({ ...input, playerId: 'player' });
    const result = advanceTownSpectacles({ ...input, town }, [input.player]);
    return { town: result.town, player: result.players[0] };
}
