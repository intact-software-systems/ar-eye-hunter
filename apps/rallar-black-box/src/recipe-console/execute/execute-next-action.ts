import type { RallarBlackBoxDistributedRunState } from
    '@shared-test/rallar-bb-test/distributed-run.ts';
import type {
    ExecuteActionPolicy,
    ExecuteConnectionTruth,
} from './execute-action-policy.ts';

export type ExecuteNextStep =
    | 'refresh-control'
    | 'connect-agents'
    | 'registering'
    | 'resolve'
    | 'create'
    | 'stage'
    | 'waiting-for-ack'
    | 'review-start'
    | 'monitor';

export type ExecuteNextAction = Readonly<{
    step: ExecuteNextStep;
    label: string;
    enabled: boolean;
    reason?: string;
    targetCount: number;
}>;

export type ExecuteNextActionInput = Readonly<{
    connection: ExecuteConnectionTruth;
    policy: ExecuteActionPolicy;
    runState?: RallarBlackBoxDistributedRunState;
    targetCount: number;
    targetableCount: number;
    launchedExpectedCount: number;
    launchedReadyCount: number;
    launchPreparationPending?: boolean;
    launchedCohortSelectionPending?: boolean;
    ackReadyCount?: number;
    ackExpectedCount?: number;
}>;

export function deriveExecuteNextAction(
    input: ExecuteNextActionInput,
): ExecuteNextAction {
    if (!['live', 'partial'].includes(input.connection)) {
        return action(
            'refresh-control',
            'Refresh control data',
            input.policy.refresh.enabled,
            input.policy.refresh.reason,
            input.targetCount,
        );
    }
    if (input.runState === 'waiting-for-ack' || input.runState === 'waiting-for-barrier') {
        const ready = input.ackReadyCount ?? 0;
        const expected = input.ackExpectedCount ?? input.targetCount;
        return action(
            'waiting-for-ack',
            `${ready} of ${expected} agents acknowledged staging`,
            false,
            'Acknowledgement advances automatically from current control polling.',
            input.targetCount,
        );
    }
    if (input.runState === 'ready') {
        return action('review-start', 'Review and start', input.policy.start.enabled,
            input.policy.start.reason, input.targetCount);
    }
    if (input.runState === 'draft') {
        return action('stage', `Stage ${input.targetCount} ${agentLabel(input.targetCount)}`,
            input.policy.stage.enabled, input.policy.stage.reason, input.targetCount);
    }
    if (input.runState !== undefined) {
        return action('monitor', 'Monitor run', true, undefined, input.targetCount);
    }
    const cohortSelectionPending = input.launchedCohortSelectionPending === true;
    if (
        input.launchPreparationPending || input.launchedExpectedCount > 0 &&
        (
            input.launchedReadyCount < input.launchedExpectedCount ||
            cohortSelectionPending
        )
    ) {
        return action(
            'registering',
            `${input.launchedReadyCount} of ${input.launchedExpectedCount} browser agents ready`,
            false,
            input.launchPreparationPending
                ? 'Fresh per-agent launch authority is being prepared.'
                : cohortSelectionPending
                ? 'The exact launched cohort is being selected as the target set.'
                : 'Registration advances automatically from current control polling.',
            input.targetCount,
        );
    }
    if (input.targetableCount === 0) {
        return action(
            'connect-agents',
            'Connect agents to continue.',
            false,
            input.policy.resolve.reason,
            input.targetCount,
        );
    }
    if (input.policy.create.enabled) {
        return action('create', 'Create draft', true, undefined, input.targetCount);
    }
    return action('resolve', `Resolve ${input.targetCount} targets`,
        input.policy.resolve.enabled, input.policy.resolve.reason, input.targetCount);
}

function action(
    step: ExecuteNextStep,
    label: string,
    enabled: boolean,
    reason: string | undefined,
    targetCount: number,
): ExecuteNextAction {
    return reason
        ? { step, label, enabled, reason, targetCount }
        : { step, label, enabled, targetCount };
}

function agentLabel(count: number): string {
    return count === 1 ? 'agent' : 'agents';
}
