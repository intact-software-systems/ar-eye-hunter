import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { RALLAR_BLACK_BOX_BARRIER_RESOLUTION_GRACE_MS } from '../../../barrier/rallar-black-box-barrier-resolution-grace-ms.ts';
import type { AlmConformanceRole } from '../alm-conformance-roles.ts';
import type { AlmConformanceStepInput } from '../alm-conformance-scenario-definition.ts';
import type { AlmConformanceCellParts } from './alm-conformance-cell-parts.ts';
import { toAlmCellArming } from './to-alm-cell-arming.ts';
import { toAlmCellBarrier, type AlmCellBarrierPhase } from './to-alm-cell-barrier.ts';
import { toAlmCellCommandPrefix } from './to-alm-cell-command-prefix.ts';

type AlmCellPartsByRole = ReadonlyMap<AlmConformanceRole, AlmConformanceCellParts>;

/**
 * What a role runs after its prologue: its body, or in a cell created `barriered` a settle role's body between the
 * cell's barriers. Every settle role meets at `connected` once every page connected, runs its arming run, and meets at
 * `armed`, so no role's body sends before every role armed its faults and its cue subscription. The successor connects
 * as a step of the cell and carries no barrier; the settle roles are every other role of the cell.
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
    const toBarrier = (phase: AlmCellBarrierPhase, timeoutMs: number) =>
        toAlmCellBarrier({
            cellPrefix: toAlmCellCommandPrefix(step.input.carrier, step.scenarioKey),
            role: step.role,
            phase,
            timeoutMs,
            participants: settleRoles
        });
    const { arming, rest } = toAlmCellArming(body);
    return [
        toBarrier('connected', computeLongestOthersMs(settleRoles, (role) => toRoleParts(role, partsByRole).prologue)),
        ...arming,
        toBarrier('armed', computeArmedBarrierTimeoutMs(settleRoles, partsByRole)),
        ...rest
    ];
}

function isSettleRole(role: AlmConformanceRole): boolean {
    return role !== 'successor';
}

/**
 * Every role leaves `connected` at once, so the first to arrive at `armed` waits at most through every other role's
 * arming run. The timeout never falls below the grace a barrier's verdict has to reach an agent, so a page that is
 * late leaving `connected`, as on a loaded machine, still arrives in time in a cell where few or no roles arm.
 */
function computeArmedBarrierTimeoutMs(
    settleRoles: readonly AlmConformanceRole[],
    partsByRole: AlmCellPartsByRole
): number {
    const armingOf = (role: AlmConformanceRole) => toAlmCellArming(toRoleParts(role, partsByRole).body).arming;
    return Math.max(RALLAR_BLACK_BOX_BARRIER_RESOLUTION_GRACE_MS, computeLongestOthersMs(settleRoles, armingOf));
}

/**
 * The longest wait of a role that arrives first and waits through every other role's commands in turn. Every arrival
 * must name the same timeout, so the cell's is that longest wait.
 */
function computeLongestOthersMs(
    settleRoles: readonly AlmConformanceRole[],
    toCommands: (role: AlmConformanceRole) => readonly RallarBlackBoxTestCommand[]
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
