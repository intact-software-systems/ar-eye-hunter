import { Either } from '@shared/resilience/Either.ts';

import { ALM_CONFORMANCE_CARRIERS, type AlmConformanceCarrier } from '../alm-conformance-carriers.ts';
import {
    ALM_CONFORMANCE_LANE_FAMILIES,
    ALM_CONFORMANCE_TAGS,
    type AlmConformanceLaneFamily,
    type AlmConformanceTag
} from '../alm-conformance-scenario-definition.ts';
import type { AlmConformanceScenario } from '../create-alm-conformance-recipes.ts';
import { isAlmLaneCellSelected } from './is-alm-lane-cell-selected.ts';

const ALM_LANE_ORDERS = ['declared', 'shuffled'] as const;

export type AlmLaneOrder = typeof ALM_LANE_ORDERS[number];

const ALM_LANE_ROOMS = ['family', 'cell'] as const;

export type AlmLaneRooms = typeof ALM_LANE_ROOMS[number];

/** The lane's environment as read; an absent or empty value takes the parameter's default. */
export interface AlmLaneParameterValues {
    readonly scope: string | undefined;
    readonly carriers: string | undefined;
    readonly families: string | undefined;
    readonly order: string | undefined;
    readonly seed: string | undefined;
    readonly rooms: string | undefined;
    readonly only: string | undefined;
    readonly skip: string | undefined;
}

export interface AlmLaneParameters {
    readonly scope: AlmConformanceTag;
    /** In catalog order. */
    readonly carriers: readonly AlmConformanceCarrier[];
    /** The families whose tests run, in declared order; the plan file still names every family. */
    readonly families: readonly AlmConformanceLaneFamily[];
    readonly order: AlmLaneOrder;
    /** Null when no seed was given: a shuffled family then mints its own. A declared order takes none. */
    readonly seed: number | null;
    readonly rooms: AlmLaneRooms;
    /** The scenario keys a run keeps; empty keeps every cell. */
    readonly only: readonly string[];
    /** The scenario ids withheld by a recorded ruling. */
    readonly skip: readonly string[];
}

/** One cell of the catalog on one carrier. */
export interface AlmLaneCatalogCell extends Pick<AlmConformanceScenario, 'scenarioId' | 'scenarioKey' | 'tags'> {
    readonly carrier: AlmConformanceCarrier;
    readonly family: AlmConformanceLaneFamily;
}

export interface DecodeAlmLaneParametersInput {
    readonly values: AlmLaneParameterValues;
    /** Every cell of the catalog, on every carrier, in every family and scope. */
    readonly catalog: readonly AlmLaneCatalogCell[];
}

type AlmLaneSelection = Pick<AlmLaneParameters, 'scope' | 'carriers' | 'families'>;

/**
 * An unset scope runs smoke, and unset carriers and families run every carrier and family; a disabled lane names its
 * skipped tests by it.
 */
export const ALM_LANE_DEFAULT_SELECTION: AlmLaneSelection = {
    scope: 'smoke',
    carriers: ALM_CONFORMANCE_CARRIERS,
    families: ALM_CONFORMANCE_LANE_FAMILIES
};

const MAX_SEED = 0xFFFF_FFFF;

/**
 * Every refused value is named with the values the lane accepts, so a run fails before any browser starts. The rules
 * compose in one way: `RALLAR_BLACK_BOX_ALM_SKIP` withholds a scenario id even when `_ONLY` names its key; `_ONLY`
 * keeps cells within `_SCOPE`, `_CARRIERS` and `_FAMILIES`, and a key it names must run in at least one of them or the
 * run is refused with the reason, judged only once those three are accepted; `_SEED` is accepted only with
 * `_ORDER=shuffled`.
 */
export function decodeAlmLaneParameters(
    input: DecodeAlmLaneParametersInput
): Either<readonly string[], AlmLaneParameters> {
    const { values } = input;
    const selection = decodeSelection(values);
    const selected = selection.fold(() => undefined, (decoded) => decoded);
    const order = toPresent(values.order) ?? 'declared';
    const seed = toPresent(values.seed);
    const rooms = toPresent(values.rooms) ?? 'family';
    const only = toListEntries(values.only);
    const skip = toListEntries(values.skip);
    const issues = [
        ...selection.fold((selectionIssues) => selectionIssues, () => []),
        ...(isAlmLaneOrder(order) ? [] : [
            `RALLAR_BLACK_BOX_ALM_ORDER=${order} is not accepted; accepted values: ${ALM_LANE_ORDERS.join(', ')}.`
        ]),
        ...validateSeed(seed, order),
        ...(isAlmLaneRooms(rooms) ? [] : [
            `RALLAR_BLACK_BOX_ALM_ROOMS=${rooms} is not accepted; accepted values: ${ALM_LANE_ROOMS.join(', ')}.`
        ]),
        ...validateSkip(skip, input.catalog),
        ...(selected === undefined ? [] : validateOnly({ only, skip, catalog: input.catalog, selection: selected }))
    ];
    if (issues.length > 0 || selected === undefined || !isAlmLaneOrder(order) || !isAlmLaneRooms(rooms)) {
        return Either.ofLeft(issues);
    }
    return Either.ofRight({ ...selected, order, seed: seed === undefined ? null : Number(seed), rooms, only, skip });
}

function decodeSelection(values: AlmLaneParameterValues): Either<readonly string[], AlmLaneSelection> {
    const scope = toPresent(values.scope) ?? ALM_LANE_DEFAULT_SELECTION.scope;
    const requested = toListEntries(values.carriers);
    const unsupported = requested.filter((entry) => !isAlmConformanceCarrier(entry));
    const requestedFamilies = toListEntries(values.families);
    const unknownFamilies = requestedFamilies.filter((entry) => !isAlmConformanceLaneFamily(entry));
    const issues = [
        ...(isAlmLaneScope(scope) ? [] : [
            `RALLAR_BLACK_BOX_ALM_SCOPE=${scope} is not accepted; accepted values: ${ALM_CONFORMANCE_TAGS.join(', ')}.`
        ]),
        ...(unsupported.length === 0 ? [] : [
            `RALLAR_BLACK_BOX_ALM_CARRIERS names unsupported carriers: ${unsupported.join(', ')}; accepted values: ` +
            `${ALM_CONFORMANCE_CARRIERS.join(', ')}.`
        ]),
        ...(unknownFamilies.length === 0 ? [] : [
            `RALLAR_BLACK_BOX_ALM_FAMILIES names unknown families: ${unknownFamilies.join(', ')}; accepted values: ` +
            `${ALM_CONFORMANCE_LANE_FAMILIES.join(', ')}.`
        ])
    ];
    if (issues.length > 0 || !isAlmLaneScope(scope)) {
        return Either.ofLeft(issues);
    }
    const carriers = requested.length === 0
        ? ALM_LANE_DEFAULT_SELECTION.carriers
        : ALM_CONFORMANCE_CARRIERS.filter((carrier) => requested.includes(carrier));
    const families = requestedFamilies.length === 0
        ? ALM_LANE_DEFAULT_SELECTION.families
        : ALM_CONFORMANCE_LANE_FAMILIES.filter((family) => requestedFamilies.includes(family));
    return Either.ofRight({ scope, carriers, families });
}

function validateSeed(seed: string | undefined, order: string): readonly string[] {
    if (seed === undefined) {
        return [];
    }
    return [
        ...(isSeed(seed) ? [] : [
            `RALLAR_BLACK_BOX_ALM_SEED=${seed} is not accepted; accepted values: an integer from 0 to ${MAX_SEED}.`
        ]),
        ...(order === 'declared'
            ? ['RALLAR_BLACK_BOX_ALM_SEED is accepted only with RALLAR_BLACK_BOX_ALM_ORDER=shuffled.']
            : [])
    ];
}

function validateSkip(skip: readonly string[], catalog: readonly AlmLaneCatalogCell[]): readonly string[] {
    const outsideCatalog = skip.filter((id) => !catalog.some((cell) => cell.scenarioId === id)).join(', ');
    return outsideCatalog.length === 0 ? [] : [
        `RALLAR_BLACK_BOX_ALM_SKIP names unknown scenario ids: ${outsideCatalog}; RALLAR_BLACK_BOX_ALM_SKIP takes ` +
        'scenario ids, RALLAR_BLACK_BOX_ALM_ONLY takes scenario keys.'
    ];
}

interface AlmLaneOnlySelection extends Pick<DecodeAlmLaneParametersInput, 'catalog'> {
    readonly selection: AlmLaneSelection;
    readonly only: readonly string[];
    readonly skip: readonly string[];
}

/** A named key must run in at least one plan of the selection; a refusal lists the keys the selection can run. */
function validateOnly(input: AlmLaneOnlySelection): readonly string[] {
    const refusals = input.only.flatMap((key) => {
        const reason = resolveOnlyRefusal(key, input);
        return reason === undefined
            ? []
            : [`RALLAR_BLACK_BOX_ALM_ONLY names ${key}, which this run cannot run: ${reason}.`];
    });
    if (refusals.length === 0) {
        return [];
    }
    const runnable = [
        ...new Set(input.catalog.filter((cell) => isRunnable(cell, input)).map((cell) => cell.scenarioKey))
    ];
    return [
        ...refusals,
        `RALLAR_BLACK_BOX_ALM_ONLY accepts the scenario keys this selection can run: ${runnable.join(', ')}.`
    ];
}

function resolveOnlyRefusal(key: string, input: AlmLaneOnlySelection): string | undefined {
    const named = input.catalog.filter((cell) => cell.scenarioKey === key);
    if (named.some((cell) => isRunnable(cell, input))) {
        return undefined;
    }
    const carried = named.filter((cell) => input.selection.carriers.includes(cell.carrier));
    const inScope = carried.filter((cell) => cell.tags.includes(input.selection.scope));
    if (named.length === 0) {
        return 'no cell of the ALM conformance catalog has that key';
    }
    if (carried.length === 0) {
        return `it is not carried over ${input.selection.carriers.join(', ')} (it runs over ` +
            `${[...new Set(named.map((cell) => cell.carrier))].join(', ')})`;
    }
    if (inScope.length === 0) {
        return `it is not in the ${input.selection.scope} scope`;
    }
    if (!inScope.some((cell) => input.selection.families.includes(cell.family))) {
        return `it runs in ${[...new Set(inScope.map((cell) => cell.family))].join(', ')}, which ` +
            'RALLAR_BLACK_BOX_ALM_FAMILIES does not select';
    }
    return 'RALLAR_BLACK_BOX_ALM_SKIP withholds it';
}

function isRunnable(cell: AlmLaneCatalogCell, input: AlmLaneOnlySelection): boolean {
    return isAlmLaneCellSelected(cell, { ...input.selection, skip: input.skip });
}

function toPresent(value: string | undefined): string | undefined {
    const trimmed = value?.trim() ?? '';
    return trimmed.length === 0 ? undefined : trimmed;
}

/** The one parser of the lane's comma-separated lists. */
function toListEntries(value: string | undefined): readonly string[] {
    return (value ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function isSeed(value: string): boolean {
    return /^\d+$/.test(value) && Number(value) <= MAX_SEED;
}

function isAlmLaneScope(value: string): value is AlmConformanceTag {
    return ALM_CONFORMANCE_TAGS.some((scope) => scope === value);
}

function isAlmConformanceCarrier(value: string): value is AlmConformanceCarrier {
    return ALM_CONFORMANCE_CARRIERS.some((carrier) => carrier === value);
}

function isAlmConformanceLaneFamily(value: string): value is AlmConformanceLaneFamily {
    return ALM_CONFORMANCE_LANE_FAMILIES.some((family) => family === value);
}

function isAlmLaneOrder(value: string): value is AlmLaneOrder {
    return ALM_LANE_ORDERS.some((order) => order === value);
}

function isAlmLaneRooms(value: string): value is AlmLaneRooms {
    return ALM_LANE_ROOMS.some((rooms) => rooms === value);
}
