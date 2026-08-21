import type { ControlFleetAgentRunOutcome, ControlFleetFailureSignature } from '../../../control-run-manager.ts';

export function fleetRegionKey(
    label: ControlFleetAgentRunOutcome['label']
): string {
    return `${label.region ?? 'unlabeled'} / ${label.provider ?? 'unknown'}`;
}

export function fleetRegionLabel(
    label: ControlFleetAgentRunOutcome['label']
): string {
    const region = label.region ?? 'unlabeled';
    const provider = label.provider ?? 'unknown provider';
    return `${region} / ${provider}`;
}

export function fleetAgentStateTone(
    state: ControlFleetAgentRunOutcome['state'] | undefined
): string {
    if (state === 'passed') {
        return 'good';
    }
    if (state === 'failed') {
        return 'bad';
    }
    if (state === 'missing' || state === 'timed-out') {
        return 'warn';
    }
    if (state === 'running') {
        return 'active';
    }
    return 'muted';
}

export function fleetFailureTone(
    category: ControlFleetFailureSignature['category']
): string {
    if (category === 'command' || category === 'runtime') {
        return 'bad';
    }
    if (category === 'diagnostic' || category === 'barrier') {
        return 'warn';
    }
    if (category === 'readiness' || category === 'targeting') {
        return 'active';
    }
    return 'muted';
}

export function fleetCellTitle(
    cell: ControlFleetAgentRunOutcome | undefined
): string {
    if (!cell) {
        return 'No result for this agent and run';
    }
    return `${cell.agentId}: ${cell.state}, ${cell.failedCommandCount} failed commands`;
}

export function shortSignatureId(value: string | undefined): string {
    if (!value) {
        return '-';
    }
    return value.length > 18 ? `${value.slice(0, 18)}...` : value;
}
