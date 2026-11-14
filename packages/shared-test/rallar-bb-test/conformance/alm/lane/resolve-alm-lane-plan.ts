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
    /** `cell` runs the cell in a room of its own, named by `toAlmLaneCellGroup`. */
    readonly room: AlmLaneRooms;
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

/**
 * Which cells of a family run, in which order and in which room. A cell runs in a room of its own when the room
 * parameter asks for one per cell or its definition declares one; a family whose pages chain one session from cell to
 * cell shares the family's room whatever the parameter asks. In a room the family shares, every cell that reshapes the
 * room's topology runs after every cell that keeps it, in any order mode: a shuffle permutes within the two groups.
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
    return {
        cells: placed.map((scenario) => ({
            scenarioKey: scenario.scenarioKey,
            room: scenario.room === 'own' ? 'cell' : rooms
        })),
        cellOrder: {
            mode: parameters.order,
            seed: ordered.seed,
            rooms,
            scenarioKeys: placed.map((scenario) => scenario.scenarioKey)
        }
    };
}

/**
 * Every agent closes its room connections after a cell in a room of its own, so the next cell connects afresh, and
 * after a cell whose next one runs in a room of its own, so that cell opens connections no earlier cell opened.
 */
export function isAlmLaneCellClosedAfter(plan: AlmLanePlan, index: number): boolean {
    return plan.cells[index]?.room === 'cell' || plan.cells[index + 1]?.room === 'cell';
}

/** A cell of its own room names the family's room with its scenario key. */
export function toAlmLaneCellGroup(
    group: RallarBlackBoxDistributedGroupRef,
    cell: AlmLanePlannedCell
): RallarBlackBoxDistributedGroupRef {
    return cell.room === 'cell' ? { ...group, groupId: `${group.groupId}-${cell.scenarioKey}` } : group;
}

function toKeptTopologyFirst(scenarios: readonly AlmLanePlanCell[]): readonly AlmLanePlanCell[] {
    return [
        ...scenarios.filter((scenario) => scenario.roomTopology === 'kept'),
        ...scenarios.filter((scenario) => scenario.roomTopology === 'reshaped')
    ];
}
