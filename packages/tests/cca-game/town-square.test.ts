import { beforeEach, describe, expect, it } from 'vitest';
import { TownRoutes } from '../../../apps/cca-2d/src/town/routes.ts';

import { createPracticeState } from '../../../apps/cca-2d/src/practice-rules.ts';
import { computeTownPosition } from '../../../apps/cca-2d/src/town/navigation.ts';

let routes: TownRoutes;
beforeEach(() => {
    routes = new TownRoutes();
});

describe('inhabited town layout', () => {
    it('fire station, café and terraces have solid footprints rather than walk-through facades', () => {
        const town = createPracticeState().town;
        expect(computeTownPosition(town, { x: -19, z: 12.05 }, { x: 0, z: 0.1 }).z).toBe(12.05);
        expect(computeTownPosition(town, { x: -19, z: -6.9 }, { x: 0, z: 0.1 }).z).toBe(-6.9);
        expect(computeTownPosition(town, { x: 0, z: -18.05 }, { x: 0, z: -0.1 }).z).toBe(-18.05);
    });
    it('public routes connect the civic, shopping, service and residential areas', () => {
        const town = createPracticeState().town;
        let position = { x: 0, z: -2 };
        for (const target of [{ x: -19, z: 11.9 }, { x: -14, z: -4 }, { x: -18, z: -12.8 }, { x: 14, z: -12 }, { x: -4, z: 12 }, { x: 0, z: 15.9 }]) {
            for (let tick = 0; tick < 900; tick++) {
                position = routes.travel({ town, from: position, target, speed: 3, step: 1 / 30 });
            }
            expect(Math.hypot(position.x - target.x, position.z - target.z)).toBeLessThan(0.4);
        }
    });
});

it('routing cache ownership, reset and moving-cart invalidation do not change travel results', () => {
    const town = createPracticeState().town;
    const request = { town, from: { x: -3, z: -8 }, target: { x: -3, z: -5 }, speed: 3, step: 1 / 30 };
    const cold = routes.travel(request);
    expect(routes.travel(request)).toEqual(cold);
    routes.clear();
    expect(routes.travel(request)).toEqual(cold);
    const moved = { ...request, town: { ...town, cart: { ...town.cart, x: 4.5 } } };
    expect(routes.travel(moved)).toEqual(new TownRoutes().travel(moved));
    expect(JSON.parse(JSON.stringify(town))).toEqual(town);
});
