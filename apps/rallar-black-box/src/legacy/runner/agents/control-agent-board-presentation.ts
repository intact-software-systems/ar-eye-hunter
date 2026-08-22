import type { ControlAgentBoardRow, ControlAgentRunParticipation } from '../../../control-agent-board.ts';

export function controlAgentVisibleParticipations(
    row: ControlAgentBoardRow
): readonly ControlAgentRunParticipation[] {
    const selected = row.selectedRun ? [row.selectedRun] : [];
    const selectedId = row.selectedRun?.distributedRunId;
    return [
        ...selected,
        ...row.activeRuns.filter((run) => run.distributedRunId !== selectedId)
    ].slice(0, 3);
}

export function controlAgentConnectionTone(row: ControlAgentBoardRow): string {
    if (row.synthetic) {
        return 'muted';
    }
    if (row.targetStatus === 'stale') {
        return 'warn';
    }
    return row.connected ? 'good' : 'muted';
}

export function controlAgentTargetTone(row: ControlAgentBoardRow): string {
    if (row.targetable) {
        return 'good';
    }
    if (
        row.targetStatus === 'missing-crdt-runtime' ||
        row.targetStatus === 'missing-crdt-transport'
    ) {
        return 'bad';
    }
    if (
        row.targetStatus === 'stale' ||
        row.targetStatus === 'different-group' ||
        row.targetStatus === 'missing-identity'
    ) {
        return 'warn';
    }
    return 'muted';
}
