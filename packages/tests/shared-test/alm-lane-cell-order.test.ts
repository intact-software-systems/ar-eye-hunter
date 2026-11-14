import { describe, expect, it } from 'vitest';

import { ALM_CONFORMANCE_CARRIERS, type AlmConformanceCarrier } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
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
    type AlmLaneCatalogCell,
    type AlmLaneParameters,
    type DecodeAlmLaneParametersInput
} from '@shared-test/rallar-bb-test/conformance/alm/lane/decode-alm-lane-parameters.ts';
import { resolveAlmLaneCellOrder } from '@shared-test/rallar-bb-test/conformance/alm/lane/resolve-alm-lane-cell-order.ts';
import {
    resolveAlmLanePlan,
    toAlmLaneCellGroup,
    type ResolveAlmLanePlanInput
} from '@shared-test/rallar-bb-test/conformance/alm/lane/resolve-alm-lane-plan.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

const KEYS = ['a', 'b', 'c', 'd', 'e', 'f'].map((scenarioKey) => ({ scenarioKey }));
const DECLARED: AlmLaneParameters = { order: 'declared', seed: null, rooms: 'family', only: [], skip: [] };
const NO_VALUES = { order: undefined, seed: undefined, rooms: undefined, only: undefined, skip: undefined };
const TOPOLOGY_RESHAPING_KEYS = ['receipted-relay-path', 'granted-rtc-relay-only', 'granted-rtc-ordered-relay'];
const CATALOG: readonly AlmLaneCatalogCell[] = ALM_CONFORMANCE_CARRIERS.flatMap((carrier) =>
    createAlmConformanceRecipes(toConformanceInput(carrier)).map(({ scenarioId, scenarioKey, tags }) => ({
        carrier,
        scenarioId,
        scenarioKey,
        tags
    }))
);
const FULL_SELECTION = { scope: 'full', carriers: ALM_CONFORMANCE_CARRIERS } as const;

function toKeys(scenarios: readonly Readonly<{ scenarioKey: string; }>[]): readonly string[] {
    return scenarios.map(({ scenarioKey }) => scenarioKey);
}

function refuseMint(): number {
    throw new Error('A seed was minted where none may be.');
}

function toFamilyCatalog(
    family: AlmConformanceLaneFamily,
    carrier: AlmConformanceCarrier = 'ws'
): readonly AlmConformanceScenario[] {
    return createAlmConformanceRecipes({ ...toConformanceInput(carrier), cellSettle: 'barriered' })
        .filter((scenario) => scenario.laneFamily === family);
}

function toDecodeInput(
    values: Partial<DecodeAlmLaneParametersInput['values']>,
    selection: DecodeAlmLaneParametersInput['selection'] = FULL_SELECTION
): DecodeAlmLaneParametersInput {
    return { values: { ...NO_VALUES, ...values }, catalog: CATALOG, selection };
}

function toIssues(input: DecodeAlmLaneParametersInput): readonly string[] {
    return decodeAlmLaneParameters(input).fold((issues) => issues, () => []);
}

function toPlanInput(
    family: AlmConformanceLaneFamily,
    parameters: Partial<AlmLaneParameters>
): ResolveAlmLanePlanInput {
    return {
        family,
        scenarios: toFamilyCatalog(family),
        scope: 'full',
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
        const refused = toIssues(toDecodeInput({ only: 'delivery-baseline, no-such-cell' }));

        expect(toKeys(kept.scenarios)).toEqual(['b', 'd']);
        expect(refused[0]).toBe(
            'RALLAR_BLACK_BOX_ALM_ONLY names no-such-cell, which this run cannot run: no cell of the ALM conformance ' +
                'catalog has that key.'
        );
        expect(refused).toHaveLength(2);
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
        expect(decodeAlmLaneParameters(toDecodeInput({})).fold(() => undefined, (decoded) => decoded)).toEqual(DECLARED);
        expect(
            decodeAlmLaneParameters(toDecodeInput({
                order: ' shuffled ',
                seed: '42',
                rooms: 'cell',
                only: 'delivery-baseline,claim-first-wins',
                skip: 'volatile-default'
            })).fold(() => undefined, (decoded) => decoded)
        ).toEqual({
            order: 'shuffled',
            seed: 42,
            rooms: 'cell',
            only: ['delivery-baseline', 'claim-first-wins'],
            skip: ['volatile-default']
        });
    });

    it('refuses every unknown value at once, naming the values the lane accepts', () => {
        const refused = toIssues(toDecodeInput({ order: 'random', seed: '-1', rooms: 'world' }));

        expect(refused).toEqual([
            'RALLAR_BLACK_BOX_ALM_ORDER=random is not accepted; accepted values: declared, shuffled.',
            'RALLAR_BLACK_BOX_ALM_SEED=-1 is not accepted; accepted values: an integer from 0 to 4294967295.',
            'RALLAR_BLACK_BOX_ALM_ROOMS=world is not accepted; accepted values: family, cell.'
        ]);
    });

    it('refuses a seed for the declared order, which takes none', () => {
        expect(toIssues(toDecodeInput({ seed: '3' }))).toEqual([
            'RALLAR_BLACK_BOX_ALM_SEED is accepted only with RALLAR_BLACK_BOX_ALM_ORDER=shuffled.'
        ]);
    });

    // missing-recipient-retry is a full-scope cell on every carrier.
    it('a named cell outside the selected scope is refused with the reason', () => {
        const refused = toIssues(toDecodeInput({ only: 'missing-recipient-retry' }, { scope: 'smoke', carriers: ['rtc'] }));

        expect(refused[0]).toBe(
            'RALLAR_BLACK_BOX_ALM_ONLY names missing-recipient-retry, which this run cannot run: it is not in the smoke scope.'
        );
    });

    // forged-recipient-ack runs over rtc alone.
    it('a named cell outside the selected carriers is refused with the reason', () => {
        const refused = toIssues(toDecodeInput({ only: 'forged-recipient-ack' }, { scope: 'full', carriers: ['ws'] }));

        expect(refused[0]).toBe(
            'RALLAR_BLACK_BOX_ALM_ONLY names forged-recipient-ack, which this run cannot run: it is not carried over ws ' +
                '(it runs over rtc).'
        );
    });

    it('a named cell withheld by the skip list is refused with the reason', () => {
        const refused = toIssues(toDecodeInput({ only: 'delivery-baseline', skip: 'delivery-baseline' }));

        expect(refused[0]).toBe(
            'RALLAR_BLACK_BOX_ALM_ONLY names delivery-baseline, which this run cannot run: RALLAR_BLACK_BOX_ALM_SKIP ' +
                'withholds it.'
        );
    });

    it('a refusal lists the cells the selection can run', () => {
        const selection = { scope: 'smoke', carriers: ['ws'] } as const;
        const runnable = [
            ...new Set(
                CATALOG
                    .filter((cell) => cell.carrier === 'ws' && cell.tags.includes('smoke') && cell.scenarioId !== 'volatile-default')
                    .map((cell) => cell.scenarioKey)
            )
        ];

        const refused = toIssues(toDecodeInput({ only: 'missing-recipient-retry', skip: 'volatile-default' }, selection));

        expect(runnable).toContain('delivery-baseline');
        expect(runnable).not.toContain('volatile-default');
        expect(refused).toEqual([
            'RALLAR_BLACK_BOX_ALM_ONLY names missing-recipient-retry, which this run cannot run: it is not in the smoke scope.',
            `RALLAR_BLACK_BOX_ALM_ONLY accepts the scenario keys this selection can run: ${runnable.join(', ')}.`
        ]);
    });

    it('a named cell any selected carrier runs in the scope is accepted', () => {
        const decoded = decodeAlmLaneParameters(toDecodeInput({ only: 'forged-recipient-ack' }, { scope: 'full', carriers: ['ws', 'rtc'] }));

        expect(decoded.fold(() => undefined, (parameters) => parameters.only)).toEqual(['forged-recipient-ack']);
    });

    it('refuses an unknown skip id, saying the skip list takes scenario ids and the only list scenario keys', () => {
        expect(toIssues(toDecodeInput({ skip: 'volatile-default, no-such-id' }))).toEqual([
            'RALLAR_BLACK_BOX_ALM_SKIP names unknown scenario ids: no-such-id; RALLAR_BLACK_BOX_ALM_SKIP takes scenario ' +
            'ids, RALLAR_BLACK_BOX_ALM_ONLY takes scenario keys.'
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
        const shuffled = ['flush-on-hide', 'durable-takeover', 'subscription-successor'];

        const plan = resolveAlmLanePlan(toPlanInput('same-context', { order: 'shuffled', seed: 3, rooms: 'cell' }));

        expect(toKeys(toFamilyCatalog('same-context'))).toEqual(['durable-takeover', 'flush-on-hide', 'subscription-successor']);
        expect(plan.cells.map((cell) => cell.scenarioKey)).toEqual(shuffled);
        expect(plan.cells.every((cell) => cell.room === 'family' && !cell.closeConnectionsAfter)).toBe(true);
        expect(plan.cellOrder).toEqual({ mode: 'shuffled', seed: 3, rooms: 'family', scenarioKeys: shuffled });
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
    // delivery-reload is a full-scope cell; the plan keeps catalog order.
    it('keeps only the scope\'s cells and never a withheld one, even when only names it', () => {
        const only = ['delivery-reload', 'delivery-baseline', 'volatile-default', 'deadline-expiry'];
        const input = toPlanInput('two-agent', { only, skip: ['volatile-default'] });

        expect(resolveAlmLanePlan({ ...input, scope: 'smoke' }).cells.map((cell) => cell.scenarioKey))
            .toEqual(['deadline-expiry', 'delivery-baseline']);
        expect(resolveAlmLanePlan(input).cells.map((cell) => cell.scenarioKey))
            .toEqual(['deadline-expiry', 'delivery-baseline', 'delivery-reload']);
    });

    it('a shuffled family room runs every topology-reshaping cell after the others', () => {
        const unconstrained = toKeys(
            resolveAlmLaneCellOrder({
                scenarios: toFamilyCatalog('three-agent', 'rtc'),
                order: 'shuffled',
                seed: 24,
                only: [],
                mintSeed: refuseMint
            }).scenarios
        );
        const plan = resolveAlmLanePlan({
            ...toPlanInput('three-agent', { order: 'shuffled', seed: 24 }),
            scenarios: toFamilyCatalog('three-agent', 'rtc')
        });
        const keys = plan.cells.map((cell) => cell.scenarioKey);

        expect(unconstrained[0]).toBe('receipted-relay-path');
        expect(keys.slice(-3).toSorted()).toEqual(TOPOLOGY_RESHAPING_KEYS.toSorted());
        expect(keys.slice(0, -3)).toEqual(unconstrained.filter((key) => !TOPOLOGY_RESHAPING_KEYS.includes(key)));
        expect(keys.slice(-3)).toEqual(unconstrained.filter((key) => TOPOLOGY_RESHAPING_KEYS.includes(key)));
    });

    it('a room per cell ignores the constraint', () => {
        const plan = resolveAlmLanePlan({
            ...toPlanInput('three-agent', { order: 'shuffled', seed: 24, rooms: 'cell' }),
            scenarios: toFamilyCatalog('three-agent', 'rtc')
        });

        expect(plan.cells[0]?.scenarioKey).toBe('receipted-relay-path');
    });

    // The declared order keeps the catalog's, which already ends with the topology-reshaping cells.
    it('the declared three-agent order ends with the topology-reshaping cells', () => {
        const keys = resolveAlmLanePlan({ ...toPlanInput('three-agent', {}), scenarios: toFamilyCatalog('three-agent', 'rtc') })
            .cells.map((cell) => cell.scenarioKey);

        expect(keys).toEqual(toKeys(toFamilyCatalog('three-agent', 'rtc')));
        expect(keys.slice(-3)).toEqual(TOPOLOGY_RESHAPING_KEYS);
    });

    it('names a room of its own per cell, and the family\'s room otherwise', () => {
        const group = { applicationId: 'app', workspaceId: 'ws', groupId: 'room-alm' };

        expect(toAlmLaneCellGroup(group, { scenarioKey: 'claim', room: 'cell', closeConnectionsAfter: true }))
            .toEqual({ ...group, groupId: 'room-alm-claim' });
        expect(toAlmLaneCellGroup(group, { scenarioKey: 'claim', room: 'family', closeConnectionsAfter: false }))
            .toBe(group);
    });
});
