import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { RALLAR_BLACK_BOX_BARRIER_RESOLUTION_GRACE_MS } from '../../../barrier/rallar-black-box-barrier-resolution-grace-ms.ts';
import type { AlmConformanceRole } from '../alm-conformance-roles.ts';
import type { AlmConformanceStepInput } from '../alm-conformance-scenario-definition.ts';
import type { AlmConformanceCellParts } from './alm-conformance-cell-parts.ts';
import { toAlmCellArming } from './to-alm-cell-arming.ts';
import { toAlmCellBarrier, type AlmCellBarrierPhase } from './to-alm-cell-barrier.ts';
import { toAlmCellCommandPrefix } from './to-alm-cell-command-prefix.ts';
import { toAlmCellSettle, type AlmCellSettle } from './to-alm-cell-settle.ts';
import { toCellHistoryMarkedCommands } from './to-cell-history-marked-commands.ts';

type AlmCellPartsByRole = ReadonlyMap<AlmConformanceRole, AlmConformanceCellParts>;

/** The commands of one role that a barrier waits out. */
type RoleCommandsSelector = (role: AlmConformanceRole) => readonly RallarBlackBoxTestCommand[];

/**
 * What a role runs after its prologue: its body, or in a cell created `barriered` a settle role's body after the
 * cell's settle. Every settle role meets at `connected` once every page connected; the receiver polls until the room
 * settled, and every role meets at `formation-settled`; each page then waits until it applied the room's head, runs
 * its arming run, and meets at `armed`, so no role's body sends before every page holds the settled room and every
 * role armed its faults and its cue subscription. The successor connects as a step of the cell and carries no
 * barrier; the settle roles are every other role of the cell.
 */
export function toAlmCellSettledBody(
    step: AlmConformanceStepInput,
    partsByRole: AlmCellPartsByRole
): readonly RallarBlackBoxTestCommand[] {
    const body = toRoleParts(step.role, partsByRole).body;
    if (step.input.cellSettle !== 'barriered' || !isSettleRole(step.role)) {
        return body;
    }
    const settleRoles = step.roles.filter(isSettleRole);
    const toBarrier = (phase: AlmCellBarrierPhase, toCommands: RoleCommandsSelector) =>
        toAlmCellBarrier({
            cellPrefix: toAlmCellCommandPrefix(step.input.carrier, step.scenarioKey),
            role: step.role,
            phase,
            timeoutMs: computeBarrierTimeoutMs(phase, settleRoles, toCommands),
            participants: settleRoles
        });
    const settleOf = (role: AlmConformanceRole) => toMarkedSettle({ ...step, role });
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

/** Each settle command's waits read its own cell's history, except where a wait declares otherwise. */
function toMarkedSettle(step: AlmConformanceStepInput): AlmCellSettle {
    const { formation, head } = toAlmCellSettle(step);
    return { formation: toCellHistoryMarkedCommands(step, formation), head: toCellHistoryMarkedCommands(step, head) };
}

/**
 * A barrier covers every other role's commands since the barrier before it, or since the start for `connected`.
 * Every role leaves a barrier at once, so a later barrier's first arrival waits at most through those commands, and
 * its timeout never falls below the grace a barrier's verdict has to reach an agent: a page that is late leaving the
 * barrier before, as on a loaded machine, still arrives in time in a cell where few or no roles run commands between.
 */
function computeBarrierTimeoutMs(
    phase: AlmCellBarrierPhase,
    settleRoles: readonly AlmConformanceRole[],
    toCommands: RoleCommandsSelector
): number {
    const longestOthersMs = computeLongestOthersMs(settleRoles, toCommands);
    return phase === 'connected'
        ? longestOthersMs
        : Math.max(RALLAR_BLACK_BOX_BARRIER_RESOLUTION_GRACE_MS, longestOthersMs);
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
