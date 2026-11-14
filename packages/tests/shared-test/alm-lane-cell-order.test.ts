import { describe, expect, it } from 'vitest';

import { ALM_CONFORMANCE_CARRIERS, type AlmConformanceCarrier } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import {
    ALM_CONFORMANCE_LANE_FAMILIES,
    type AlmConformanceLaneFamily,
    type AlmConformanceTag
} from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts';
import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import {
    decodeAlmLaneParameters,
    type AlmLaneCatalogCell,
    type AlmLaneParameters,
    type AlmLaneRooms,
    type DecodeAlmLaneParametersInput
} from '@shared-test/rallar-bb-test/conformance/alm/lane/decode-alm-lane-parameters.ts';
import { resolveAlmLaneCellOrder } from '@shared-test/rallar-bb-test/conformance/alm/lane/resolve-alm-lane-cell-order.ts';
import {
    isAlmLaneCellClosedAfter,
    resolveAlmLanePlan,
    toAlmLaneCellGroup,
    type AlmLanePlan,
    type AlmLanePlannedCell,
    type ResolveAlmLanePlanInput
} from '@shared-test/rallar-bb-test/conformance/alm/lane/resolve-alm-lane-plan.ts';
import { toAlmLaneEmptyPlanReason } from '@shared-test/rallar-bb-test/conformance/alm/lane/to-alm-lane-empty-plan-reason.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

const KEYS = ['a', 'b', 'c', 'd', 'e', 'f'].map((scenarioKey) => ({ scenarioKey }));
const DECLARED: AlmLaneParameters = {
    scope: 'full',
    carriers: ALM_CONFORMANCE_CARRIERS,
    order: 'declared',
    seed: null,
    rooms: 'family',
    only: [],
    skip: []
};
const NO_VALUES = {
    scope: undefined,
    carriers: undefined,
    order: undefined,
    seed: undefined,
    rooms: undefined,
    only: undefined,
    skip: undefined
};
const TOPOLOGY_RESHAPING_KEYS = ['receipted-relay-path', 'granted-rtc-relay-only', 'granted-rtc-ordered-relay'];
const CATALOG: readonly AlmLaneCatalogCell[] = ALM_CONFORMANCE_CARRIERS.flatMap((carrier) =>
    createAlmConformanceRecipes(toConformanceInput(carrier)).map(({ scenarioId, scenarioKey, tags }) => ({
        carrier,
        scenarioId,
        scenarioKey,
        tags
    }))
);
const FAMILY_CATALOGS = new Map(
    ALM_CONFORMANCE_CARRIERS.flatMap((carrier) =>
        ALM_CONFORMANCE_LANE_FAMILIES.map((family) => [`${family}/${carrier}`, toFamilyCatalog(family, carrier)] as const)
    )
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

/** A selection is the scope and carrier values a run states; a value given beside it wins. */
function toDecodeInput(
    values: Partial<DecodeAlmLaneParametersInput['values']>,
    selection: Readonly<{ scope: AlmConformanceTag; carriers: readonly AlmConformanceCarrier[]; }> = FULL_SELECTION
): DecodeAlmLaneParametersInput {
    const selected = { scope: selection.scope, carriers: selection.carriers.join(',') };
    return { values: { ...NO_VALUES, ...selected, ...values }, catalog: CATALOG };
}

function toDecoded(input: DecodeAlmLaneParametersInput): AlmLaneParameters | undefined {
    return decodeAlmLaneParameters(input).fold(() => undefined, (decoded) => decoded);
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
        carrier: 'ws',
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
            scope: 'full',
            carriers: ALM_CONFORMANCE_CARRIERS,
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

    // A repository variable that is not set reaches the workflow step as an empty string, so empty counts as unset.
    it('an unset or empty scope runs smoke, and unset or empty carriers run every carrier', () => {
        for (const unset of [undefined, '', ' ']) {
            expect(toDecoded(toDecodeInput({ scope: unset, carriers: unset })), String(unset)).toEqual({
                ...DECLARED,
                scope: 'smoke'
            });
        }
    });

    it('accepts each scope and each carrier, and keeps the carriers in catalog order', () => {
        const toSelection = (decoded: AlmLaneParameters | undefined) => [decoded?.scope, decoded?.carriers];

        expect(toSelection(toDecoded(toDecodeInput({ scope: 'smoke' })))).toEqual(['smoke', ALM_CONFORMANCE_CARRIERS]);
        expect(toSelection(toDecoded(toDecodeInput({ scope: ' full ' })))).toEqual(['full', ALM_CONFORMANCE_CARRIERS]);
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            expect(toDecoded(toDecodeInput({ carriers: carrier }))?.carriers).toEqual([carrier]);
        }
        expect(toDecoded(toDecodeInput({ carriers: 'rtc-with-ws-fallback, ws' }))?.carriers).toEqual([
            'ws',
            'rtc-with-ws-fallback'
        ]);
    });

    it('refuses an unknown scope and an unknown carrier, and judges no named cell against them', () => {
        expect(toIssues(toDecodeInput({ scope: 'ful', carriers: 'ws,tcp,udp', only: 'delivery-baseline' }))).toEqual([
            'RALLAR_BLACK_BOX_ALM_SCOPE=ful is not accepted; accepted values: smoke, full.',
            'RALLAR_BLACK_BOX_ALM_CARRIERS names unsupported carriers: tcp, udp; accepted values: ws, rtc, ' +
            'rtc-with-ws-fallback.'
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
            'bounded-rejection',
            'deadline-expiry',
            'delivery-baseline',
            'delivery-lifecycle',
            'durable-opt-in',
            'server-originated',
            'paced-latest',
            'paced-newest-n',
            'paced-expiry',
            'paced-capacity',
            'paced-fairness',
            'paced-cancel',
            'paced-isolation-resources',
            'paced-isolation-lists'
        ];

        const refused = toIssues(toDecodeInput({ only: 'missing-recipient-retry', skip: 'volatile-default' }, selection));

        expect(refused).toEqual([
            'RALLAR_BLACK_BOX_ALM_ONLY names missing-recipient-retry, which this run cannot run: it is not in the smoke scope.',
            `RALLAR_BLACK_BOX_ALM_ONLY accepts the scenario keys this selection can run: ${runnable.join(', ')}.`
        ]);
    });

    // The decoder accepts a key and the plan runs it by the one rule `isAlmLaneCellSelected`; a drift between them would
    // let a named cell be accepted and never run.
    it.each(
        [
            { scope: 'smoke', carriers: ['ws'], skip: [] },
            { scope: 'full', carriers: ['ws'], skip: [] },
            { scope: 'full', carriers: ['rtc'], skip: [] },
            { scope: 'full', carriers: ['ws', 'rtc'], skip: ['volatile-default', 'delivery-baseline'] },
            { scope: 'smoke', carriers: ['rtc'], skip: ['delivery-baseline'] }
        ] as const
    )('the decoder accepts a key exactly when a plan of the selection contains it: $scope $carriers skip $skip', ({ scope, carriers, skip }) => {
        const keys = [...new Set(CATALOG.map((cell) => cell.scenarioKey))];
        const selection = { scope, carriers };

        for (const key of keys) {
            const accepted = decodeAlmLaneParameters(
                toDecodeInput({ only: key, skip: skip.join(',') }, selection)
            ).fold(() => false, () => true);
            const planned = carriers.some((carrier) =>
                ALM_CONFORMANCE_LANE_FAMILIES.some((family) =>
                    resolveAlmLanePlan({
                        family,
                        carrier,
                        scenarios: FAMILY_CATALOGS.get(`${family}/${carrier}`)!,
                        scope,
                        parameters: { ...DECLARED, only: [key], skip },
                        mintSeed: refuseMint
                    }).cells.length > 0
                )
            );

            expect(accepted, `${key} over ${carriers.join('+')} in ${scope}`).toBe(planned);
        }
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
    // The lane resolves a family's plan once and both skips and announces from it, so the seed printed is the one used.
    it('a shuffled family plan that names no seed mints one seed, the one its cell order records', () => {
        const minted: number[] = [];
        const plan = resolveAlmLanePlan({
            ...toPlanInput('two-agent', { order: 'shuffled' }),
            mintSeed: () => {
                minted.push(11);
                return 11;
            }
        });

        expect(minted).toEqual([11]);
        expect(plan.cellOrder.seed).toBe(11);
        expect(plan.cells.length).toBeGreaterThan(0);
    });

    it('a cell whose definition declares a room of its own plans one in a family room, and the others plan the family\'s', () => {
        const declared = toFamilyCatalog('same-principal').filter((scenario) => scenario.room === 'own');
        const plan = resolveAlmLanePlan(toPlanInput('same-principal', { rooms: 'family' }));

        expect(declared.map((scenario) => scenario.scenarioKey)).toEqual(['server-ordered-entry']);
        expect(plan.cells).toEqual(
            plan.cells.map(({ scenarioKey }) => ({ scenarioKey, room: scenarioKey === 'server-ordered-entry' ? 'cell' : 'family' }))
        );
        expect(plan.cellOrder.rooms).toBe('family');
    });

    it('every four-role cell declares a room of its own, so it plans one whatever the room parameter says', () => {
        expect(toFamilyCatalog('four-role').every((scenario) => scenario.room === 'own')).toBe(true);
        for (const rooms of ['family', 'cell'] as const) {
            const plan = resolveAlmLanePlan(toPlanInput('four-role', { rooms }));

            expect(plan.cells.length, rooms).toBeGreaterThan(0);
            expect(plan.cells, rooms).toEqual(toPlannedCells(plan, 'cell'));
            expect(plan.cellOrder.rooms, rooms).toBe(rooms);
        }
    });

    it('every agent closes its connections after a cell in a room of its own and before one', () => {
        const plan = {
            cells: [
                { scenarioKey: 'a', room: 'family' },
                { scenarioKey: 'b', room: 'family' },
                { scenarioKey: 'c', room: 'cell' },
                { scenarioKey: 'd', room: 'family' },
                { scenarioKey: 'e', room: 'cell' },
                { scenarioKey: 'f', room: 'cell' }
            ],
            cellOrder: { mode: 'declared', seed: null, rooms: 'family', scenarioKeys: ['a', 'b', 'c', 'd', 'e', 'f'] }
        } as const;

        expect(plan.cells.map((_cell, index) => isAlmLaneCellClosedAfter(plan, index)))
            .toEqual([false, true, true, true, true, true]);
    });

    it('same-context cells are shuffled and never get a room of their own', () => {
        const shuffled = ['flush-on-hide', 'durable-takeover', 'subscription-successor'];

        const plan = resolveAlmLanePlan(toPlanInput('same-context', { order: 'shuffled', seed: 3, rooms: 'cell' }));

        expect(toKeys(toFamilyCatalog('same-context'))).toEqual(['durable-takeover', 'flush-on-hide', 'subscription-successor']);
        expect(plan.cells.map((cell) => cell.scenarioKey)).toEqual(shuffled);
        expect(plan.cells).toEqual(toPlannedCells(plan, 'family'));
        expect(plan.cellOrder).toEqual({ mode: 'shuffled', seed: 3, rooms: 'family', scenarioKeys: shuffled });
    });

    it('a room per cell gives every cell of any agent family a room of its own; a family room gives one where declared', () => {
        const agentFamilies = ALM_CONFORMANCE_LANE_FAMILIES.filter((family) => family !== 'same-context');
        for (const family of agentFamilies) {
            const perCell = resolveAlmLanePlan(toPlanInput(family, { rooms: 'cell' }));
            const perFamily = resolveAlmLanePlan(toPlanInput(family, { rooms: 'family' }));

            expect(perCell.cells.length, family).toBeGreaterThan(0);
            expect(perCell.cells, family).toEqual(toPlannedCells(perCell, 'cell'));
            const declaredRooms = new Map(
                toFamilyCatalog(family).map((scenario) => [scenario.scenarioKey, scenario.room === 'own' ? 'cell' : 'family'])
            );
            expect(perFamily.cells, family).toEqual(
                perFamily.cells.map(({ scenarioKey }) => ({ scenarioKey, room: declaredRooms.get(scenarioKey) }))
            );
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

        expect(toAlmLaneCellGroup(group, { scenarioKey: 'claim', room: 'cell' }))
            .toEqual({ ...group, groupId: 'room-alm-claim' });
        expect(toAlmLaneCellGroup(group, { scenarioKey: 'claim', room: 'family' }))
            .toBe(group);
    });
});

describe('the reason an emptied plan skips its family', () => {
    const otherwise = 'no full baseline ALM scenario runs over ws';
    const base = { family: 'addressed', carrier: 'rtc', scope: 'full', skip: [], otherwise } as const;
    const fullCell: Pick<AlmConformanceScenario, 'scenarioId' | 'tags'> = { scenarioId: 'delivery-baseline', tags: ['full'] };
    const smokeOnlyCell: Pick<AlmConformanceScenario, 'scenarioId' | 'tags'> = { scenarioId: 'volatile-default', tags: ['smoke'] };

    it('is the family\'s own reason while no cell was named', () => {
        expect(toAlmLaneEmptyPlanReason({ ...base, only: [], scenarios: [fullCell] })).toBe(otherwise);
    });

    it('names the keys and the family when RALLAR_BLACK_BOX_ALM_ONLY emptied a family that would run cells', () => {
        expect(toAlmLaneEmptyPlanReason({ ...base, only: ['claim-first-wins', 'durable-opt-in'], scenarios: [fullCell] }))
            .toBe('RALLAR_BLACK_BOX_ALM_ONLY=claim-first-wins,durable-opt-in plans no cell of addressed over rtc');
    });

    it('keeps the family\'s own reason when it is empty for another cause, whatever was named', () => {
        const noCellInScope = { ...base, only: ['claim-first-wins'], scenarios: [smokeOnlyCell] };
        const everyCellSkipped = { ...base, only: ['claim-first-wins'], scenarios: [fullCell], skip: ['delivery-baseline'] };

        expect(toAlmLaneEmptyPlanReason(noCellInScope)).toBe(otherwise);
        expect(toAlmLaneEmptyPlanReason(everyCellSkipped)).toBe(otherwise);
    });
});

function toPlannedCells(plan: AlmLanePlan, room: AlmLaneRooms): readonly AlmLanePlannedCell[] {
    return plan.cells.map(({ scenarioKey }) => ({ scenarioKey, room }));
}
