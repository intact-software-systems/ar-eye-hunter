import {
    isDistributedRunTerminalState,
    type RallarBlackBoxDistributedRunState,
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import type {
    ControlQueryAuthorization,
    ControlQueryError,
    ControlQueryReachability,
    ControlQueryStatus,
} from '../control/control-query.ts';

export type MonitorAction =
    | 'refresh'
    | 'cancel'
    | 'load-artifact'
    | 'export-artifact';
export type MonitorConnectionTruth =
    | ControlQueryStatus
    | 'error'
    | 'auth-required'
    | 'credential-trust';
export type MonitorEvidenceFreshness = 'none' | 'current' | 'last-known';
export type MonitorActionBlockCode =
    | 'busy'
    | 'connection'
    | 'run-unavailable'
    | 'last-known'
    | 'terminal-run'
    | 'arming-required';
export type MonitorActionDecision =
    | Readonly<{ enabled: true; code?: never; reason?: never }>
    | Readonly<{
        enabled: false;
        code: MonitorActionBlockCode;
        reason: string;
    }>;
export type MonitorActionPolicy = Readonly<
    Record<MonitorAction, MonitorActionDecision>
>;

export type MonitorActionPolicyInput = Readonly<{
    connection: MonitorConnectionTruth;
    evidence: MonitorEvidenceFreshness;
    runState?: RallarBlackBoxDistributedRunState;
    cancelArmKey?: string;
    armedKey?: string;
    busyAction?: MonitorAction;
}>;

export type MonitorCancelArmContext = Readonly<{
    key: string;
    label: string;
}>;

export function createMonitorCancelArmContext(input: Readonly<{
    baseUrl: string;
    controlRunId: string;
    distributedRunId: string;
    runState: RallarBlackBoxDistributedRunState;
    updatedAtEpochMs: number;
}>): MonitorCancelArmContext {
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
    return {
        key: JSON.stringify({
            baseUrl,
            controlRunId: input.controlRunId,
            distributedRunId: input.distributedRunId,
            runState: input.runState,
            updatedAtEpochMs: input.updatedAtEpochMs,
        }),
        label: `Cancel ${input.distributedRunId} at ${baseUrl} in current state ${input.runState}`,
    };
}

export function monitorConnectionTruth(input: Readonly<{
    status: ControlQueryStatus;
    reachability: ControlQueryReachability;
    authorization: ControlQueryAuthorization;
    lastError?: ControlQueryError;
}>): MonitorConnectionTruth {
    if (input.lastError?.credentialTrustRequired === true) {
        return 'credential-trust';
    }
    if (input.authorization === 'required') {
        return 'auth-required';
    }
    if (input.status === 'offline' && input.reachability === 'reachable') {
        return 'error';
    }
    return input.status;
}

export function deriveMonitorActionPolicy(
    input: MonitorActionPolicyInput,
): MonitorActionPolicy {
    if (input.busyAction) {
        return allBlocked(
            'busy',
            `${monitorActionLabel(input.busyAction)} is already in progress.`,
        );
    }

    const policy: Record<MonitorAction, MonitorActionDecision> = {
        refresh: enabled(),
        cancel: blocked(
            'connection',
            'Complete live control truth is required to cancel.',
        ),
        'load-artifact': blocked(
            'connection',
            'Current live or partial control truth is required to load an artifact.',
        ),
        'export-artifact': blocked(
            'connection',
            'Current live or partial control truth is required to export an artifact.',
        ),
    };

    if (input.evidence === 'none' || !input.runState) {
        return blockRunActions(
            policy,
            'run-unavailable',
            'Select a known distributed run.',
        );
    }
    if (input.evidence === 'last-known') {
        return blockRunActions(
            policy,
            'last-known',
            'Last-known evidence is not current enough for remote operations.',
        );
    }
    if (input.connection !== 'live' && input.connection !== 'partial') {
        return policy;
    }

    policy['load-artifact'] = enabled();
    policy['export-artifact'] = enabled();
    if (input.connection === 'partial') return policy;

    if (isDistributedRunTerminalState(input.runState)) {
        policy.cancel = blocked(
            'terminal-run',
            `Run state ${input.runState} is already terminal.`,
        );
    } else if (
        input.cancelArmKey && input.armedKey === input.cancelArmKey
    ) {
        policy.cancel = enabled();
    } else {
        policy.cancel = blocked(
            'arming-required',
            'Review and arm Cancel for the exact current control endpoint and run.',
        );
    }
    return policy;
}

function blockRunActions(
    policy: Record<MonitorAction, MonitorActionDecision>,
    code: MonitorActionBlockCode,
    reason: string,
): MonitorActionPolicy {
    policy.cancel = blocked(code, reason);
    policy['load-artifact'] = blocked(code, reason);
    policy['export-artifact'] = blocked(code, reason);
    return policy;
}

function allBlocked(
    code: MonitorActionBlockCode,
    reason: string,
): MonitorActionPolicy {
    return Object.fromEntries([
        'refresh',
        'cancel',
        'load-artifact',
        'export-artifact',
    ].map(action => [action, blocked(code, reason)])) as MonitorActionPolicy;
}

function enabled(): MonitorActionDecision {
    return { enabled: true };
}

function blocked(
    code: MonitorActionBlockCode,
    reason: string,
): MonitorActionDecision {
    return { enabled: false, code, reason };
}

function monitorActionLabel(action: MonitorAction): string {
    return action.split('-').map(part =>
        part.charAt(0).toUpperCase() + part.slice(1)
    ).join(' ');
}
