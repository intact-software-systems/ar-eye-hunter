import type { ControlFleetFailureSignature } from '@shared-test/rallar-bb-test/fleet-report.ts';

type FleetFailureCategory = ControlFleetFailureSignature['category'];

export function toFleetFailureCategory(code: string | undefined, message: string | undefined): FleetFailureCategory {
    const text = `${code ?? ''} ${message ?? ''}`.toLowerCase();
    if (text.includes('target')) {
        return 'targeting';
    }
    if (text.includes('ack')) {
        return 'readiness';
    }
    if (text.includes('barrier')) {
        return 'barrier';
    }
    if (text.includes('diagnostic')) {
        return 'diagnostic';
    }
    if (text.includes('runtime')) {
        return 'runtime';
    }
    return code || message ? 'command' : 'unknown';
}

export function toFleetFailureLikelyCause(
    category: FleetFailureCategory,
    code: string | undefined,
    message: string
): string {
    switch (category) {
        case 'targeting':
            return 'The resolved agent fleet did not match the distributed target policy.';
        case 'readiness':
            return 'One or more agents did not acknowledge staging before the timeout.';
        case 'barrier':
            return 'One or more agents did not reach synchronized barrier readiness.';
        case 'diagnostic':
            return 'Runtime transport diagnostics correlated with the distributed run.';
        case 'command':
            return message || code || 'A recipe command failed on at least one agent.';
        default:
            return message || 'The distributed run recorded a failure without a more specific category.';
    }
}

export function toFleetFailureNextAction(
    category: FleetFailureCategory,
    code: string | undefined,
    transport: string | undefined
): string {
    if (category === 'targeting') {
        return 'Check agent group/application/workspace labels and expected participant count.';
    }
    if (category === 'readiness') {
        return 'Inspect missing ACK agents and confirm they are logged in, connected, and not blocked on recipe load.';
    }
    if (category === 'barrier') {
        return 'Compare per-agent barrier readiness and reconnect/heartbeat history.';
    }
    if (category === 'diagnostic') {
        return transport === 'ws'
            ? 'Inspect WebSocket subscription/topic evidence for affected regions.'
            : 'Inspect RTC lane, peer, group, and topic evidence for affected agents.';
    }
    return code?.includes('ASSERT')
        ? 'Open the failing command result and compare expected vs observed payload evidence.'
        : 'Open the run report, first failure, and raw evidence for one affected agent.';
}
