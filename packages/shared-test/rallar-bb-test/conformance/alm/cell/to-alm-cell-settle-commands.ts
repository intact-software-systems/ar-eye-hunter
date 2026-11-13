import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceRole } from '../alm-conformance-roles.ts';
import type { AlmConformanceStepInput } from '../alm-conformance-scenario-definition.ts';
import { toAlmCellBarrier } from './to-alm-cell-barrier.ts';

/**
 * The commands a settle role runs between its prologue and its body: none unless the cell is created `barriered`, and
 * none for the successor, which connects as a step of the cell. The settle roles are every other role of the cell.
 */
export function toAlmCellSettleCommands(
    step: AlmConformanceStepInput,
    prologueByRole: ReadonlyMap<AlmConformanceRole, readonly RallarBlackBoxTestCommand[]>
): readonly RallarBlackBoxTestCommand[] {
    if (step.input.cellSettle !== 'barriered' || !isSettleRole(step.role)) {
        return [];
    }
    const settleRoles = step.roles.filter(isSettleRole);
    return [
        toAlmCellBarrier({
            cellPrefix: `alm-${step.input.carrier}-${step.scenarioKey}`,
            role: step.role,
            phase: 'connected',
            timeoutMs: computeConnectedBarrierTimeoutMs(settleRoles, prologueByRole),
            participants: settleRoles
        })
    ];
}

function isSettleRole(role: AlmConformanceRole): boolean {
    return role !== 'successor';
}

/**
 * The lane starts each role once the one before it connected, so the first role to arrive waits through every other
 * role's prologue in turn. Every arrival must name the same timeout, so the cell's is the longest such wait.
 */
function computeConnectedBarrierTimeoutMs(
    settleRoles: readonly AlmConformanceRole[],
    prologueByRole: ReadonlyMap<AlmConformanceRole, readonly RallarBlackBoxTestCommand[]>
): number {
    const prologueMsByRole = new Map(settleRoles.map((role) => [role, computePrologueMs(role, prologueByRole)]));
    const totalMs = [...prologueMsByRole.values()].reduce((sum, prologueMs) => sum + prologueMs, 0);
    return Math.max(...[...prologueMsByRole.values()].map((prologueMs) => totalMs - prologueMs));
}

function computePrologueMs(
    role: AlmConformanceRole,
    prologueByRole: ReadonlyMap<AlmConformanceRole, readonly RallarBlackBoxTestCommand[]>
): number {
    const prologue = prologueByRole.get(role);
    if (prologue === undefined) {
        throw new Error(`The cell declares ${role} without its prologue.`);
    }
    return prologue.reduce((sum, command) => {
        if (command.timeoutMs === undefined) {
            throw new Error(`${command.commandId ?? role} names no timeout, so the cell's barrier cannot cover it.`);
        }
        return sum + command.timeoutMs;
    }, 0);
}
