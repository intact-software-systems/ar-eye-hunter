import type { RallarBlackBoxTestBarrierCommand } from '../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceRole } from '../alm-conformance-roles.ts';

/**
 * Where a cell's roles meet. The hosted combined recipe opens each block at `start` and sends at `armed`; the local
 * lane meets at `connected` once every page connected, at `formation-settled` once the receiver found the room settled,
 * and at `armed` once every page applied the room's head and every role ran its arming run.
 */
export type AlmCellBarrierPhase = 'start' | 'connected' | 'formation-settled' | 'armed';

export interface AlmCellBarrierInput {
    /** The cell's `alm-<carrier>-<scenarioKey>`, which starts every command id of the cell. */
    readonly cellPrefix: string;
    readonly role: AlmConformanceRole;
    readonly phase: AlmCellBarrierPhase;
    readonly timeoutMs: number;
    /** Undefined, every started agent of the run meets, as in the hosted run; the local lane names the cell's roles. */
    readonly participants: readonly AlmConformanceRole[] | undefined;
}

/** Every role of the cell arrives at one barrier id; each role's own command id names it. */
export function toAlmCellBarrier(input: AlmCellBarrierInput): RallarBlackBoxTestBarrierCommand {
    return {
        kind: 'barrier',
        commandId: `${input.cellPrefix}-${input.role}-${input.phase}`,
        barrierId: `${input.cellPrefix}-${input.phase}`,
        timeoutMs: input.timeoutMs,
        ...(input.participants === undefined ? {} : { participants: input.participants })
    };
}
