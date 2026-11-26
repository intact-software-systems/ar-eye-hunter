import { beforeEach, describe, expect, it } from 'vitest';
import {
    computePracticeTick,
    createPracticeState,
    type PracticeState
} from '../../../apps/grumpy-town/src/practice-rules.ts';
import { advanceTownRaid } from '../../../apps/grumpy-town/src/town/raid.ts';
import { computeTownSoilingActors, splashTownActors } from '../../../apps/grumpy-town/src/town/soiling.ts';
import { TownRoutes } from '../../../apps/grumpy-town/src/town/town-routes.ts';

let routes: TownRoutes;
beforeEach(() => {
    routes = new TownRoutes();
});

function advance(state: PracticeState, seconds: number): PracticeState {
    for (let tick = 0; tick < seconds * 60; tick++) {
        state = computePracticeTick(state, { x: 0, z: 0, dash: state.consumedDash }, { seconds: 1 / 60, routes });
    }
    return state;
}

describe('government crackdown', () => {
    it('six fresh incidents award one big bonus and dispatch ten police from government', () => {
        const initial = createPracticeState();
        const sixth = computePracticeTick({ ...initial, x: 5, z: 1.35, town: { ...initial.town, heat: 5, score: 40 } }, { x: 0, z: 1, dash: 1 }, {
            seconds: 1 / 60,
            routes
        });
        expect(sixth.town.score).toBe(100);
        expect(sixth.town.raid.phase).toBe('alarm');
        expect(sixth.town.raid.bonuses).toBe(1);
        const deployed = advance({ ...sixth, x: 22, z: -22, vx: 0, vz: 0, dashTime: 0 }, 5.1);
        expect(deployed.town.raid.phase).toBe('active');
        expect(deployed.town.raid.guards).toHaveLength(10);
        expect(deployed.town.raid.guards.every((guard) => guard.z > 14)).toBe(true);
        expect(deployed.town.score).toBe(100);
        const returning = advance(deployed, 25);
        expect(returning.town.raid.phase).toBe('returning');
        const home = advance(returning, 15);
        expect(home.town.raid.phase).toBe('returning');
        expect(home.town.raid.guards).toHaveLength(0);
        const quiet = advance(home, 15);
        expect(quiet.town.raid.phase).toBe('quiet');
        expect(quiet.town.raid.guards).toHaveLength(0);
        expect(quiet.town.raid.bonuses).toBe(1);
    }, 30_000);
    it('a splash cannot reveal police still waiting inside government or earn credit from them', () => {
        const player = { ...createPracticeState(), x: 20, z: -20 };
        const input = { routes, player, town: { ...player.town, heat: 6 }, dash: false, now: 0, step: 1 / 60 };
        const alarm = advanceTownRaid(input);
        const active = advanceTownRaid({ ...input, town: alarm, now: 5 });
        const guards = active.raid.guards.map((guard) => guard.id === 0 ? { ...guard, x: 10, z: 10 } : guard);
        const splash = splashTownActors({
            radius: 1.25,
            town: { ...active, raid: { ...active.raid, guards } },
            source: { x: 0, z: 15 },
            target: { x: 0, z: 15.9 },
            kind: 'poop',
            now: 5.1
        }, [player]);
        expect(splash.town.raid.guards.filter((guard) => guard.stain !== 'clean')).toHaveLength(0);
        expect(splash.town.raid.guards.filter((guard) => guard.mode !== 'emerging' || guard.until <= 5.1)).toHaveLength(1);
        expect(splash.hitResident).toBe(false);
        const contact = computeTownSoilingActors({
            ...input,
            now: 5.1,
            town: { ...active, raid: { ...active.raid, guards }, patches: [{ id: 1, kind: 'pee', born: 5, expires: 10, x: 0, z: 15.9 }] }
        }, [player]);
        expect(contact.town.raid.guards.filter((guard) => guard.stain !== 'clean')).toHaveLength(0);
    });
    it('empty dash spam does not build trouble or award a crackdown bonus', () => {
        let state = createPracticeState();
        for (let dash = 1; dash <= 8; dash++) {
            state = computePracticeTick({ ...state, x: 20, z: -20, cooldown: 0 }, { x: 0, z: 1, dash }, { seconds: 1 / 60, routes });
        }
        expect(state.town.heat).toBe(0);
        expect(state.town.raid.phase).toBe('quiet');
        expect(state.town.score).toBe(0);
    });
});

describe('living market', () => {
    it('contains two distinct birds, dogs and cats plus five interactive street objects', () => {
        const town = createPracticeState().town;
        for (const kind of ['bird', 'dog', 'cat']) {
            expect(town.creatures.filter((creature) => creature.kind === kind)).toHaveLength(2);
        }
        expect(town.objects).toHaveLength(5);
    });
});

describe('street mischief', () => {
    it.each(
        [
            ['bin-west', -3.5, -3.45, 'trash'],
            ['bin-east', 6, 10.05, 'trash'],
            ['fish', -7, 6.95, 'fish'],
            ['toilet', 5, -5.55, 'poop'],
            ['hydrant', -5.5, -6.85, 'water']
        ] as const
    )('%s spills its own mess, rewards once and gets repaired by its owner', (id, x, z, kind) => {
        const initial = { ...createPracticeState(), x, z };
        const walking = computePracticeTick(initial, { x: 0, z: 1, dash: 0 }, { seconds: 1 / 60, routes });
        expect(walking.town.mischief).toBe(0);
        const hit = computePracticeTick(initial, { x: 0, z: 1, dash: 1 }, { seconds: 1 / 60, routes });
        expect(hit.town.objects.find((object) => object.id === id)?.damagedUntil).toBeGreaterThan(hit.elapsed);
        expect(hit.town.patches.filter((patch) => patch.kind === kind).length).toBeGreaterThan(0);
        expect(hit.town.score).toBe(10);
        const repeated = computePracticeTick({ ...hit, cooldown: 0 }, { x: 0, z: 1, dash: 2 }, { seconds: 1 / 60, routes });
        expect(repeated.town.score).toBe(10);
        const repaired = advance({ ...hit, x: 22, z: -22, vx: 0, vz: 0, dashTime: 0 }, 20);
        const object = repaired.town.objects.find((object) => object.id === id)!;
        expect(object.damagedUntil).toBe(0);
        expect(object.repair).toBeGreaterThanOrEqual(3);
    });
    it('six actual different messes summon police, and additional pranks cannot cancel or extend dispatch', () => {
        let state = createPracticeState();
        for (const [x, z] of [[-3.5, -3.45], [6, 10.05], [-7, 6.95], [5, -5.55], [-5.5, -6.85], [5, 1.35]]) {
            state = computePracticeTick({ ...state, x, z }, { x: 0, z: 1, dash: state.consumedDash + 1 }, { seconds: 1 / 60, routes });
            state = advance({ ...state, x: 22, z: -22, vx: 0, vz: 0, dashTime: 0 }, 3.1);
        }
        expect(state.town.mischief).toBe(6);
        expect(state.town.score).toBe(110);
        expect(state.town.raid.phase).toBe('alarm');
        const deadline = state.town.raid.until;
        const more = computePracticeTick({ ...state, x: 0, z: 6.35 }, { x: 0, z: 1, dash: state.consumedDash + 1 }, { seconds: 1 / 60, routes });
        expect(more.town.raid.until).toBe(deadline);
        expect(more.town.raid.bonuses).toBe(1);
        expect(more.town.heat).toBe(6);
    });
});
