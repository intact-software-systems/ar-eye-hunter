import type { RallarBlackBoxTestRuntimeStatus } from '@shared-test/rallar-bb-test/types.ts';
import type {
    RecipeLaunchState,
    RunnerReadinessCheck,
    RunnerServiceProbeStatus,
} from '../../../runner-readiness.ts';

export type RunnerServiceProbe = Readonly<{
    status: RunnerServiceProbeStatus;
    detail: string;
}>;

export function runnerLaunchStateFromRunState(
    runState: RallarBlackBoxTestRuntimeStatus | string,
): RecipeLaunchState {
    if (runState === 'running') {
        return 'running';
    }
    if (runState === 'passed' || runState === 'completed') {
        return 'passed';
    }
    if (runState === 'failed' || runState === 'cancelled') {
        return 'failed';
    }
    return 'idle';
}

export function runnerLaunchTone(state: RecipeLaunchState): string {
    if (state === 'passed') {
        return 'good';
    }
    if (state === 'failed') {
        return 'bad';
    }
    if (state === 'preparing' || state === 'running') {
        return 'active';
    }
    return 'muted';
}

export function runnerReadinessCheckTone(
    check: RunnerReadinessCheck,
): string {
    if (check.status === 'ready') {
        return 'good';
    }
    if (check.status === 'warning') {
        return 'warn';
    }
    if (check.status === 'checking') {
        return 'active';
    }
    return 'bad';
}
