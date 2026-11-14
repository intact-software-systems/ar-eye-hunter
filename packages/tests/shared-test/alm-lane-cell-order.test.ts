import { describe, expect, it } from 'vitest';

import {
    ALM_CONFORMANCE_LANE_FAMILIES,
    type AlmConformanceLaneFamily
} from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts';
import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import {
    decodeAlmLaneParameters,
    type AlmLaneParameters
} from '@shared-test/rallar-bb-test/conformance/alm/lane/decode-alm-lane-parameters.ts';
import { resolveAlmLaneCellOrder } from '@shared-test/rallar-bb-test/conformance/alm/lane/resolve-alm-lane-cell-order.ts';
import {
    resolveAlmLanePlan,
    toAlmLaneCellGroup,
    type ResolveAlmLanePlanInput
} from '@shared-test/rallar-bb-test/conformance/alm/lane/resolve-alm-lane-plan.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

const KEYS = ['a', 'b', 'c', 'd', 'e', 'f'].map((scenarioKey) => ({ scenarioKey }));
const DECLARED: AlmLaneParameters = { order: 'declared', seed: null, rooms: 'family', only: [] };
const NO_VALUES = { order: undefined, seed: undefined, rooms: undefined, only: undefined };

function toKeys(scenarios: readonly Readonly<{ scenarioKey: string; }>[]): readonly string[] {
    return scenarios.map(({ scenarioKey }) => scenarioKey);
}

function refuseMint(): number {
    throw new Error('A seed was minted where none may be.');
}

function toFamilyCatalog(family: AlmConformanceLaneFamily): readonly AlmConformanceScenario[] {
    return createAlmConformanceRecipes({ ...toConformanceInput('ws'), cellSettle: 'barriered' })
        .filter((scenario) => scenario.laneFamily === family);
}

function toPlanInput(
    family: AlmConformanceLaneFamily,
    parameters: Partial<AlmLaneParameters>
): ResolveAlmLanePlanInput {
    return {
        family,
        scenarios: toFamilyCatalog(family),
        scope: 'full',
        skippedScenarioIds: [],
        parameters: { ...DECLARED, ...parameters },
        mintSeed: refuseMint
    };
}

describe('the ALM lane cell order', () => {
    it('declared keeps the catalog order', () => {
        const resolved = resolveAlmLaneCellOrder({ scenarios: KEYS, order: 'declared', seed: null, only: [], mintSeed: refuseMint });

        expect(toKeys(resolved.scenarios)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
        expect(resolved.seed).toBeNull();
    });

    // The order a seed gives is pinned, so a seed printed on one machine replays the same order on any other.
    it('one seed gives one order and records it', () => {
        const toShuffled = (seed: number) => resolveAlmLaneCellOrder({ scenarios: KEYS, order: 'shuffled', seed, only: [], mintSeed: refuseMint });

        expect(toKeys(toShuffled(1).scenarios)).toEqual(['e', 'b', 'f', 'c', 'a', 'd']);
        expect(toShuffled(1).seed).toBe(1);
        expect(toKeys(toShuffled(1).scenarios)).toEqual(toKeys(toShuffled(1).scenarios));
        expect(toKeys(toShuffled(2).scenarios)).toEqual(['a', 'c', 'd', 'f', 'b', 'e']);
    });

    it('only keeps the named keys and rejects an unknown one', () => {
        const kept = resolveAlmLaneCellOrder({
            scenarios: KEYS,
            order: 'declared',
            seed: null,
            only: ['d', 'b'],
            mintSeed: refuseMint
        });
        const refused = decodeAlmLaneParameters({
            values: { ...NO_VALUES, only: 'b, no-such-cell' },
            catalogKeys: ['a', 'b']
        });

        expect(toKeys(kept.scenarios)).toEqual(['b', 'd']);
        expect(refused.fold((issues) => issues, () => [])).toEqual([
            'RALLAR_BLACK_BOX_ALM_ONLY names unknown scenario keys: no-such-cell; accepted values: the scenario keys of ' +
            'the ALM conformance catalog.'
        ]);
    });

    it('a shuffled order with no seed mints one and returns it', () => {
        const resolved = resolveAlmLaneCellOrder({
            scenarios: KEYS,
            order: 'shuffled',
            seed: null,
            only: [],
            mintSeed: () => 7
        });

        expect(resolved.seed).toBe(7);
        expect(toKeys(resolved.scenarios)).toEqual(['e', 'b', 'c', 'd', 'f', 'a']);
    });
});

describe('the ALM lane parameters', () => {
    it('default to the declared order in the family\'s room with every cell', () => {
        expect(decodeAlmLaneParameters({ values: NO_VALUES, catalogKeys: [] }).fold(() => undefined, (decoded) => decoded))
            .toEqual(DECLARED);
        expect(
            decodeAlmLaneParameters({
                values: { order: ' shuffled ', seed: '42', rooms: 'cell', only: 'a,b' },
                catalogKeys: ['a', 'b']
            }).fold(() => undefined, (decoded) => decoded)
        ).toEqual({ order: 'shuffled', seed: 42, rooms: 'cell', only: ['a', 'b'] });
    });

    it('refuses every unknown value at once, naming the values the lane accepts', () => {
        const refused = decodeAlmLaneParameters({
            values: { order: 'random', seed: '-1', rooms: 'world', only: undefined },
            catalogKeys: []
        });

        expect(refused.fold((issues) => issues, () => [])).toEqual([
            'RALLAR_BLACK_BOX_ALM_ORDER=random is not accepted; accepted values: declared, shuffled.',
            'RALLAR_BLACK_BOX_ALM_SEED=-1 is not accepted; accepted values: an integer from 0 to 4294967295.',
            'RALLAR_BLACK_BOX_ALM_ROOMS=world is not accepted; accepted values: family, cell.'
        ]);
    });

    it('refuses a seed for the declared order, which takes none', () => {
        const refused = decodeAlmLaneParameters({ values: { ...NO_VALUES, seed: '3' }, catalogKeys: [] });

        expect(refused.fold((issues) => issues, () => [])).toEqual([
            'RALLAR_BLACK_BOX_ALM_SEED is accepted only with RALLAR_BLACK_BOX_ALM_ORDER=shuffled.'
        ]);
    });
});

describe('the ALM lane plan', () => {
    it('four-role cells run in a room of their own whatever the room parameter says', () => {
        for (const rooms of ['family', 'cell'] as const) {
            const plan = resolveAlmLanePlan(toPlanInput('four-role', { rooms }));

            expect(plan.cells.length, rooms).toBeGreaterThan(0);
            expect(plan.cells.every((cell) => cell.room === 'cell' && cell.closeConnectionsAfter), rooms).toBe(true);
            expect(plan.cellOrder.rooms, rooms).toBe('cell');
        }
    });

    it('same-context cells are shuffled and never get a room of their own', () => {
        const catalog = toFamilyCatalog('same-context');
        const shuffled = resolveAlmLaneCellOrder({
            scenarios: catalog,
            order: 'shuffled',
            seed: 3,
            only: [],
            mintSeed: refuseMint
        });

        const plan = resolveAlmLanePlan(toPlanInput('same-context', { order: 'shuffled', seed: 3, rooms: 'cell' }));

        expect(catalog.length).toBeGreaterThan(1);
        expect(plan.cells.map((cell) => cell.scenarioKey)).toEqual(toKeys(shuffled.scenarios));
        expect(plan.cells.every((cell) => cell.room === 'family' && !cell.closeConnectionsAfter)).toBe(true);
        expect(plan.cellOrder).toEqual({ mode: 'shuffled', seed: 3, rooms: 'family', scenarioKeys: toKeys(shuffled.scenarios) });
    });

    it('a room per cell closes every connection before the next cell, for any agent family', () => {
        const agentFamilies = ALM_CONFORMANCE_LANE_FAMILIES.filter((family) => family !== 'same-context');
        for (const family of agentFamilies) {
            const perCell = resolveAlmLanePlan(toPlanInput(family, { rooms: 'cell' }));
            const perFamily = resolveAlmLanePlan(toPlanInput(family, { rooms: 'family' }));

            expect(perCell.cells.length, family).toBeGreaterThan(0);
            expect(perCell.cells.every((cell) => cell.room === 'cell' && cell.closeConnectionsAfter), family).toBe(true);
            expect(
                perFamily.cells.every((cell) => family === 'four-role' || (cell.room === 'family' && !cell.closeConnectionsAfter)),
                family
            ).toBe(true);
        }
    });

    it('records the declared order with no seed, in the family\'s room', () => {
        const plan = resolveAlmLanePlan(toPlanInput('three-agent', {}));

        expect(plan.cellOrder).toEqual({
            mode: 'declared',
            seed: null,
            rooms: 'family',
            scenarioKeys: toKeys(toFamilyCatalog('three-agent'))
        });
    });

    // A withheld cell needs its recorded ruling to run again, so `only` cannot bring it back.
    it('keeps only the scope\'s cells and never a withheld one, even when only names it', () => {
        const input = toPlanInput('two-agent', { only: ['delivery-baseline', 'volatile-default', 'deadline-expiry'] });
        const smoke = resolveAlmLanePlan({ ...input, scope: 'smoke', skippedScenarioIds: ['volatile-default'] });
        const smokeKeys = toKeys(
            toFamilyCatalog('two-agent').filter((scenario) =>
                scenario.tags.includes('smoke') && input.parameters.only.includes(scenario.scenarioKey) &&
                scenario.scenarioId !== 'volatile-default'
            )
        );

        expect(smokeKeys.length).toBeGreaterThan(0);
        expect(smoke.cells.map((cell) => cell.scenarioKey)).toEqual(smokeKeys);
    });

    it('names a room of its own per cell, and the family\'s room otherwise', () => {
        const group = { applicationId: 'app', workspaceId: 'ws', groupId: 'room-alm' };

        expect(toAlmLaneCellGroup(group, { scenarioKey: 'claim', room: 'cell', closeConnectionsAfter: true }))
            .toEqual({ ...group, groupId: 'room-alm-claim' });
        expect(toAlmLaneCellGroup(group, { scenarioKey: 'claim', room: 'family', closeConnectionsAfter: false }))
            .toBe(group);
    });
});
