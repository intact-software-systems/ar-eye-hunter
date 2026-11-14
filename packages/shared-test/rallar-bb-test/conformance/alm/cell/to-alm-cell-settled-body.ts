import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { RALLAR_BLACK_BOX_BARRIER_RESOLUTION_GRACE_MS } from '../../../barrier/rallar-black-box-barrier-resolution-grace-ms.ts';
import type { AlmConformanceCellParts } from '../alm-conformance-cell-parts.ts';
import type { AlmConformanceRole } from '../alm-conformance-roles.ts';
import type { AlmConformanceStepInput } from '../alm-conformance-scenario-definition.ts';
import { toAlmCellArming } from './to-alm-cell-arming.ts';
import { toAlmCellSettleCommand } from './to-alm-cell-authored-commands.ts';
import { toAlmCellBarrier, type AlmCellBarrierPhase } from './to-alm-cell-barrier.ts';
import { toAlmCellCommandPrefix } from './to-alm-cell-command-prefix.ts';
import { toAlmCellPlacedBody } from './to-alm-cell-placed-body.ts';
import { toAlmCellSettle, type AlmCellSettle } from './to-alm-cell-settle.ts';
import { toCellHistoryMarkedCommands } from './to-cell-history-marked-commands.ts';

type AlmCellPartsByRole = ReadonlyMap<AlmConformanceRole, AlmConformanceCellParts>;

/** The commands of one role that a barrier waits out. */
type RoleCommandsSelector = (role: AlmConformanceRole) => readonly RallarBlackBoxTestCommand[];

/**
 * What a role runs after its prologue: its body, or in a cell created `barriered` a settle role's body after the
 * cell's settle. Every settle role meets at `connected` once every page connected; the receiver writes the cell's
 * start state, which every role's membership lets it write, and polls until the room settled, and every role meets at
 * `formation-settled`; each page then waits until it applied the room's head, runs
 * its arming run, and meets at `armed`, so no role's body sends before every page holds the settled room and every
 * role armed its faults and its cue subscription. The successor connects as a step of the cell and carries no
 * barrier; the settle roles are every other role of the cell.
 */
export function toAlmCellSettledBody(
    step: AlmConformanceStepInput,
    partsByRole: AlmCellPartsByRole
): readonly RallarBlackBoxTestCommand[] {
    const parts = toRoleParts(step.role, partsByRole);
    const body = parts.body;
    if (step.input.cellSettle !== 'barriered' || !isSettleRole(step.role)) {
        return toAlmCellPlacedBody(parts);
    }
    const settleRoles = step.roles.filter(isSettleRole);
    const toBarrier = (phase: AlmCellBarrierPhase, toCommands: RoleCommandsSelector) =>
        toAlmCellSettleCommand(toAlmCellBarrier({
            cellPrefix: toAlmCellCommandPrefix(step.input.carrier, step.scenarioKey),
            role: step.role,
            phase,
            timeoutMs: computeBarrierTimeoutMs(settleRoles, toCommands),
            participants: settleRoles
        }));
    const settleOf = (role: AlmConformanceRole) =>
        toMarkedSettle({ ...step, role }, toRoleParts(role, partsByRole).startState);
    const armingOf = (role: AlmConformanceRole) => toAlmCellArming(toRoleParts(role, partsByRole).body).arming;
    const { formation, head } = settleOf(step.role);
    return [
        toBarrier('connected', (role) => toRoleParts(role, partsByRole).prologue),
        ...formation,
        toBarrier('formation-settled', (role) => settleOf(role).formation),
        ...head,
        ...armingOf(step.role),
        toBarrier('armed', (role) => [...settleOf(role).head, ...armingOf(role)]),
        ...toAlmCellArming(body).rest
    ];
}

function isSettleRole(role: AlmConformanceRole): boolean {
    return role !== 'successor';
}

/**
 * Each settle command is declared one, so a role's authored commands leave it out, and its waits read its own cell's
 * history, except where a wait declares otherwise.
 */
function toMarkedSettle(
    step: AlmConformanceStepInput,
    startState: readonly RallarBlackBoxTestCommand[]
): AlmCellSettle {
    const { formation, head } = toAlmCellSettle(step);
    const toMarked = (commands: readonly RallarBlackBoxTestCommand[]) =>
        toCellHistoryMarkedCommands(step, commands).map(toAlmCellSettleCommand);
    return { formation: toMarked([...startState, ...formation]), head: toMarked(head) };
}

/**
 * A barrier's window opens at its first arrival and covers every other role's commands since the barrier before it,
 * or since the start for `connected`, plus the grace a barrier's verdict has to reach an agent, which also covers the
 * skew between pages leaving the barrier before: a role whose commands succeed in their last milliseconds still
 * arrives inside the window. A passing cell pays nothing for it, since a barrier resolves at its last arrival.
 */
function computeBarrierTimeoutMs(settleRoles: readonly AlmConformanceRole[], toCommands: RoleCommandsSelector): number {
    return computeLongestOthersMs(settleRoles, toCommands) + RALLAR_BLACK_BOX_BARRIER_RESOLUTION_GRACE_MS;
}

/**
 * The longest wait of a role that arrives first and waits through every other role's commands in turn. Every arrival
 * must name the same timeout, so the cell's is that longest wait.
 */
function computeLongestOthersMs(
    settleRoles: readonly AlmConformanceRole[],
    toCommands: RoleCommandsSelector
): number {
    const msByRole = settleRoles.map((role) => computeCommandsMs(role, toCommands(role)));
    const totalMs = msByRole.reduce((sum, ms) => sum + ms, 0);
    return Math.max(...msByRole.map((ms) => totalMs - ms));
}

function computeCommandsMs(role: AlmConformanceRole, commands: readonly RallarBlackBoxTestCommand[]): number {
    return commands.reduce((sum, command) => {
        if (command.timeoutMs === undefined) {
            throw new Error(`${command.commandId ?? role} names no timeout, so the cell's barrier cannot cover it.`);
        }
        return sum + command.timeoutMs;
    }, 0);
}

function toRoleParts(role: AlmConformanceRole, partsByRole: AlmCellPartsByRole): AlmConformanceCellParts {
    const parts = partsByRole.get(role);
    if (parts === undefined) {
        throw new Error(`The cell declares ${role} without its parts.`);
    }
    return parts;
}
