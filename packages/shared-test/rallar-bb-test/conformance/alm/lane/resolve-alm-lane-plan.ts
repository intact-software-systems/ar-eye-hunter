import type { RallarBlackBoxDistributedGroupRef } from '../../../distributed-run.ts';

import type { AlmConformanceCarrier } from '../alm-conformance-carriers.ts';
import {
    ALM_CONFORMANCE_FAMILY_SESSIONS,
    type AlmConformanceLaneFamily,
    type AlmConformanceTag
} from '../alm-conformance-scenario-definition.ts';
import type { AlmConformanceScenario } from '../create-alm-conformance-recipes.ts';
import type { AlmLaneOrder, AlmLaneParameters, AlmLaneRooms } from './decode-alm-lane-parameters.ts';
import { isAlmLaneCellSelected } from './is-alm-lane-cell-selected.ts';
import { resolveAlmLaneCellOrder } from './resolve-alm-lane-cell-order.ts';

export interface ResolveAlmLanePlanInput {
    readonly family: AlmConformanceLaneFamily;
    readonly carrier: AlmConformanceCarrier;
    /** The family's catalog cells on the run's carrier, in declared order. */
    readonly scenarios: readonly AlmLanePlanCell[];
    readonly scope: AlmConformanceTag;
    /** A cell whose id `skip` names never runs, even when `only` names its key. */
    readonly parameters: AlmLaneParameters;
    /** Called once, for a shuffled order that names no seed. */
    readonly mintSeed: () => number;
}

type AlmLanePlanCell = Pick<AlmConformanceScenario, 'scenarioId' | 'scenarioKey' | 'tags' | 'roomTopology' | 'room'>;

export interface AlmLanePlannedCell {
    readonly scenarioKey: string;
    /**
     * The key of the room the cell runs in, which `toAlmLaneCellGroup` names: `family`, the family's first room;
     * `family-<n>`, a later room the family's cells share; `cell-<scenarioKey>`, a room of the cell's own.
     */
    readonly room: string;
}

/** What the observation artifact records of the plan, so a run can be replayed in its order. */
export interface AlmLaneCellOrderRecord {
    readonly mode: AlmLaneOrder;
    /** The seed a shuffled order used, given or minted; null for the declared order. */
    readonly seed: number | null;
    /** The room parameter as the family ran it; a cell that declares a room of its own runs in one under either. */
    readonly rooms: AlmLaneRooms;
    readonly scenarioKeys: readonly string[];
}

export interface AlmLanePlan {
    readonly cells: readonly AlmLanePlannedCell[];
    readonly cellOrder: AlmLaneCellOrderRecord;
}

/** The key of the room a family's first shared cells run in: the family's own group. */
const ALM_LANE_FAMILY_ROOM = 'family';

/**
 * Which cells of a family run, in which order and in which room. A cell runs in a room of its own when the room
 * parameter asks for one per cell or its definition declares one; a family whose pages chain one session from cell to
 * cell shares the family's room whatever the parameter asks. No cell rejoins a room its pages left: the shared-room
 * cells after a cell in its own room run in a fresh shared room. In a room the family shares, every cell that reshapes
 * the room's topology runs after every cell that keeps it, in any order mode: a shuffle permutes within the two groups.
 */
export function resolveAlmLanePlan(input: ResolveAlmLanePlanInput): AlmLanePlan {
    const { parameters } = input;
    const ordered = resolveAlmLaneCellOrder({
        scenarios: input.scenarios.filter((scenario) =>
            isAlmLaneCellSelected(
                { ...scenario, carrier: input.carrier },
                { scope: input.scope, carriers: [input.carrier], skip: parameters.skip }
            )
        ),
        order: parameters.order,
        seed: parameters.seed,
        only: parameters.only,
        mintSeed: input.mintSeed
    });
    const rooms = ALM_CONFORMANCE_FAMILY_SESSIONS[input.family] === 'chained' ? 'family' : parameters.rooms;
    const placed = rooms === 'cell' ? ordered.scenarios : toKeptTopologyFirst(ordered.scenarios);
    const roomKeys = toAlmLaneRoomKeys(placed, rooms);
    return {
        cells: placed.map((scenario, index) => ({ scenarioKey: scenario.scenarioKey, room: roomKeys[index]! })),
        cellOrder: {
            mode: parameters.order,
            seed: ordered.seed,
            rooms,
            scenarioKeys: placed.map((scenario) => scenario.scenarioKey)
        }
    };
}

/**
 * Every agent closes its room connections where the next cell runs in another room, and after the family's last cell
 * unless it ran in the family's first room, so no page stays in a room it will not use again.
 */
export function isAlmLaneRoomLeftAfter(plan: AlmLanePlan, index: number): boolean {
    const room = plan.cells[index]?.room;
    const next = plan.cells[index + 1];
    return next === undefined ? room !== ALM_LANE_FAMILY_ROOM : next.room !== room;
}

/** The family's first room is the family's group; every other room names that group with its key. */
export function toAlmLaneCellGroup(
    group: RallarBlackBoxDistributedGroupRef,
    cell: AlmLanePlannedCell
): RallarBlackBoxDistributedGroupRef {
    return cell.room === ALM_LANE_FAMILY_ROOM ? group : { ...group, groupId: `${group.groupId}-${cell.room}` };
}

function toKeptTopologyFirst(scenarios: readonly AlmLanePlanCell[]): readonly AlmLanePlanCell[] {
    return [
        ...scenarios.filter((scenario) => scenario.roomTopology === 'kept'),
        ...scenarios.filter((scenario) => scenario.roomTopology === 'reshaped')
    ];
}

/** A shared-room cell after a cell in its own room opens a fresh shared room once the family's current one was used. */
function toAlmLaneRoomKeys(scenarios: readonly AlmLanePlanCell[], rooms: AlmLaneRooms): readonly string[] {
    let shared = 1;
    let sharedUsed = false;
    let sharedLeft = false;
    return scenarios.map((scenario) => {
        if (rooms === 'cell' || scenario.room === 'own') {
            sharedLeft = sharedUsed;
            return `cell-${scenario.scenarioKey}`;
        }
        if (sharedLeft) {
            shared += 1;
            sharedLeft = false;
        }
        sharedUsed = true;
        return shared === 1 ? ALM_LANE_FAMILY_ROOM : `${ALM_LANE_FAMILY_ROOM}-${shared}`;
    });
}
