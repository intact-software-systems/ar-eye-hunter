import type { ControlDistributedRunCommandPhase } from '@shared-test/rallar-bb-test/control-snapshots.ts';

import type { ControlDistributedRunState, ControlRunState } from '../control-service-state.ts';
import { isDistributedAckTimedOut, isDistributedBarrierTimedOut } from './distributed-run-evaluation.ts';

export interface DistributedRunLifecycleInput {
    readonly distributedRun: ControlDistributedRunState;
    readonly run: ControlRunState | undefined;
    readonly nowEpochMs: number;
}

export type DistributedRunNextStep = 'hold' | 'queue-barrier' | 'mark-ready' | 'queue-start';

export interface DistributedRunAdvance {
    readonly completesBarrier: boolean;
    readonly next: DistributedRunNextStep;
}

const HOLD: DistributedRunAdvance = { completesBarrier: false, next: 'hold' };

export function resolveDistributedRunAdvance(input: DistributedRunLifecycleInput): DistributedRunAdvance {
    const { distributedRun, run, nowEpochMs } = input;
    if (distributedRun.state === 'waiting-for-ack') {
        if (
            isDistributedAckTimedOut(distributedRun, nowEpochMs) ||
            !haveTargetsPassedPhase(distributedRun, run, 'stage')
        ) {
            return HOLD;
        }
        return {
            completesBarrier: false,
            next: isBarrierEnabled(distributedRun) ? 'queue-barrier' : resolveReadyStep(distributedRun, nowEpochMs)
        };
    }
    if (distributedRun.state === 'waiting-for-barrier') {
        if (
            isDistributedBarrierTimedOut(distributedRun, nowEpochMs) ||
            !haveTargetsPassedPhase(distributedRun, run, 'barrier')
        ) {
            return HOLD;
        }
        return { completesBarrier: true, next: resolveReadyStep(distributedRun, nowEpochMs) };
    }
    return distributedRun.state === 'ready' && isAutoStartDue(distributedRun, nowEpochMs)
        ? { completesBarrier: false, next: 'queue-start' }
        : HOLD;
}

export function resolveDistributedRunStartStep(input: DistributedRunLifecycleInput): DistributedRunNextStep {
    const { distributedRun, run, nowEpochMs } = input;
    const hasStageLinks = distributedRun.commandLinks.some((link) => link.phase === 'stage');
    if (hasStageLinks && !haveTargetsPassedPhase(distributedRun, run, 'stage')) {
        return 'hold';
    }
    if (hasStageLinks && isBarrierEnabled(distributedRun)) {
        if (!distributedRun.commandLinks.some((link) => link.phase === 'barrier')) {
            return 'queue-barrier';
        }
        if (!haveTargetsPassedPhase(distributedRun, run, 'barrier')) {
            return 'hold';
        }
    }
    return isScheduledStartPending(distributedRun, nowEpochMs) ? 'mark-ready' : 'queue-start';
}

function resolveReadyStep(distributedRun: ControlDistributedRunState, nowEpochMs: number): DistributedRunNextStep {
    return isAutoStartDue(distributedRun, nowEpochMs) ? 'queue-start' : 'mark-ready';
}

function haveTargetsPassedPhase(
    distributedRun: ControlDistributedRunState,
    run: ControlRunState | undefined,
    phase: ControlDistributedRunCommandPhase
): boolean {
    if (!run || distributedRun.targetAgentIds.length === 0) {
        return false;
    }
    return distributedRun.targetAgentIds.every((agentId) => {
        const links = distributedRun.commandLinks.filter((link) => link.phase === phase && link.agentId === agentId);
        return links.length > 0 && links.every((link) => run.results.get(link.commandId)?.ok === true);
    });
}

function isBarrierEnabled(distributedRun: ControlDistributedRunState): boolean {
    return distributedRun.manifest.barrier.enabled;
}

function isAutoStartDue(distributedRun: ControlDistributedRunState, nowEpochMs: number): boolean {
    const manifest = distributedRun.manifest;
    return manifest.startMode === 'auto-after-ready' ||
        (manifest.startMode === 'scheduled' && nowEpochMs >= manifest.startDeadlineEpochMs);
}

function isScheduledStartPending(distributedRun: ControlDistributedRunState, nowEpochMs: number): boolean {
    const manifest = distributedRun.manifest;
    return manifest.startMode === 'scheduled' && nowEpochMs < manifest.startDeadlineEpochMs;
}
