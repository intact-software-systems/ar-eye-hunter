import { Either } from '@shared/resilience/Either.ts';

export const ALM_LANE_ORDERS = ['declared', 'shuffled'] as const;

export type AlmLaneOrder = typeof ALM_LANE_ORDERS[number];

export const ALM_LANE_ROOMS = ['family', 'cell'] as const;

export type AlmLaneRooms = typeof ALM_LANE_ROOMS[number];

/** The lane's environment as read; an absent or empty value takes the parameter's default. */
export interface AlmLaneParameterValues {
    readonly order: string | undefined;
    readonly seed: string | undefined;
    readonly rooms: string | undefined;
    readonly only: string | undefined;
}

export interface AlmLaneParameters {
    readonly order: AlmLaneOrder;
    /** Null when no seed was given: a shuffled family then mints its own. A declared order takes none. */
    readonly seed: number | null;
    readonly rooms: AlmLaneRooms;
    /** The scenario keys a run keeps; empty keeps every cell. */
    readonly only: readonly string[];
}

export interface DecodeAlmLaneParametersInput {
    readonly values: AlmLaneParameterValues;
    /** Every scenario key of the catalog, on any carrier, family and scope: `only` may name no other. */
    readonly catalogKeys: readonly string[];
}

const MAX_SEED = 0xFFFF_FFFF;

/** Every refused value is named with the values the lane accepts, so a run fails before any browser starts. */
export function decodeAlmLaneParameters(
    input: DecodeAlmLaneParametersInput
): Either<readonly string[], AlmLaneParameters> {
    const { values } = input;
    const order = toPresent(values.order) ?? 'declared';
    const seed = toPresent(values.seed);
    const rooms = toPresent(values.rooms) ?? 'family';
    const only = toListEntries(values.only);
    const unknownKeys = only.filter((key) => !input.catalogKeys.includes(key));
    const issues = [
        ...(isAlmLaneOrder(order) ? [] : [
            `RALLAR_BLACK_BOX_ALM_ORDER=${order} is not accepted; accepted values: ${ALM_LANE_ORDERS.join(', ')}.`
        ]),
        ...(seed === undefined || isSeed(seed) ? [] : [
            `RALLAR_BLACK_BOX_ALM_SEED=${seed} is not accepted; accepted values: an integer from 0 to ${MAX_SEED}.`
        ]),
        ...(seed === undefined || order !== 'declared' ? [] : [
            'RALLAR_BLACK_BOX_ALM_SEED is accepted only with RALLAR_BLACK_BOX_ALM_ORDER=shuffled.'
        ]),
        ...(isAlmLaneRooms(rooms) ? [] : [
            `RALLAR_BLACK_BOX_ALM_ROOMS=${rooms} is not accepted; accepted values: ${ALM_LANE_ROOMS.join(', ')}.`
        ]),
        ...(unknownKeys.length === 0 ? [] : [
            `RALLAR_BLACK_BOX_ALM_ONLY names unknown scenario keys: ${unknownKeys.join(', ')}; accepted values: ` +
            'the scenario keys of the ALM conformance catalog.'
        ])
    ];
    if (issues.length > 0 || !isAlmLaneOrder(order) || !isAlmLaneRooms(rooms)) {
        return Either.ofLeft(issues);
    }
    return Either.ofRight({ order, seed: seed === undefined ? null : Number(seed), rooms, only });
}

function toPresent(value: string | undefined): string | undefined {
    const trimmed = value?.trim() ?? '';
    return trimmed.length === 0 ? undefined : trimmed;
}

function toListEntries(value: string | undefined): readonly string[] {
    return (value ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function isSeed(value: string): boolean {
    return /^\d+$/.test(value) && Number(value) <= MAX_SEED;
}

function isAlmLaneOrder(value: string): value is AlmLaneOrder {
    return ALM_LANE_ORDERS.some((order) => order === value);
}

function isAlmLaneRooms(value: string): value is AlmLaneRooms {
    return ALM_LANE_ROOMS.some((rooms) => rooms === value);
}
