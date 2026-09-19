import type { ControlDistributedRunCommandPhase } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type { RallarBlackBoxDistributedRunRecipeSelection } from '@shared-test/rallar-bb-test/distributed-run.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecord
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import { toCommandIdSegment } from '../control-command-queue-policy.ts';
import type { ControlDistributedRunState, ControlRunState } from '../control-service-state.ts';
import { toDistributedRecipeKey, toRecipeSelectionsForAgent } from './distributed-run-targeting.ts';

export interface DistributedPhaseCommand {
    readonly phase: ControlDistributedRunCommandPhase;
    readonly agentId: string;
    readonly selection: RallarBlackBoxDistributedRunRecipeSelection | undefined;
    readonly command: RallarBlackBoxTestCommand;
}

export interface RecoveredDistributedCommandLink {
    readonly phase: ControlDistributedRunCommandPhase;
    readonly agentId: string;
    readonly commandId: string;
    readonly recipeId: string | undefined;
    readonly role: string | undefined;
    readonly evidenceQueuedAtEpochMs: number | undefined;
}

interface DistributedPhaseTarget {
    readonly distributedRun: ControlDistributedRunState;
    readonly phase: ControlDistributedRunCommandPhase;
    readonly agentId: string;
    readonly selection: RallarBlackBoxDistributedRunRecipeSelection | undefined;
}

interface DistributedRecipeTarget extends DistributedPhaseTarget {
    readonly phase: 'stage' | 'start';
    readonly selection: RallarBlackBoxDistributedRunRecipeSelection;
}

const BARRIER_RECIPE_KEY = 'ready';
const CANCEL_RECIPE_KEY = 'run';
const COMMAND_ID_FALLBACK_SEGMENT = 'segment';

export function toDistributedStageCommands(
    distributedRun: ControlDistributedRunState
): readonly DistributedPhaseCommand[] {
    return toRecipePhaseTargets(distributedRun, 'stage').map((target) => ({
        ...toPhaseCommandTarget(target),
        command: toDistributedStageCommand(target)
    }));
}

export function toDistributedStartCommands(
    distributedRun: ControlDistributedRunState
): readonly DistributedPhaseCommand[] {
    return toRecipePhaseTargets(distributedRun, 'start').map((target) => ({
        ...toPhaseCommandTarget(target),
        command: toDistributedStartCommand(target)
    }));
}

export function toDistributedBarrierCommands(
    distributedRun: ControlDistributedRunState
): readonly DistributedPhaseCommand[] {
    return distributedRun.targetAgentIds.map((agentId) => {
        const target: DistributedPhaseTarget = { distributedRun, phase: 'barrier', agentId, selection: undefined };
        return {
            ...toPhaseCommandTarget(target),
            command: {
                kind: 'health',
                commandId: toDistributedCommandId(target, BARRIER_RECIPE_KEY),
                label: `Barrier ready ${distributedRun.distributedRunId}`,
                metadata: { ...toDistributedCommandMetadata(target), barrier: toBarrierMetadata(distributedRun) }
            }
        };
    });
}

export function toDistributedCancelCommands(
    distributedRun: ControlDistributedRunState,
    reason: string
): readonly DistributedPhaseCommand[] {
    return distributedRun.targetAgentIds.map((agentId) => {
        const target: DistributedPhaseTarget = { distributedRun, phase: 'cancel', agentId, selection: undefined };
        return {
            ...toPhaseCommandTarget(target),
            command: {
                kind: 'recipe.cancel',
                commandId: toDistributedCommandId(target, CANCEL_RECIPE_KEY),
                label: `Cancel distributed run ${distributedRun.distributedRunId}`,
                reason,
                metadata: toDistributedCommandMetadata(target)
            }
        };
    });
}

export function toRecoveredDistributedCommandLinks(
    distributedRun: ControlDistributedRunState,
    run: ControlRunState | undefined
): readonly RecoveredDistributedCommandLink[] {
    if (!run) {
        return [];
    }

    const linkedCommandIds = new Set(distributedRun.commandLinks.map((link) => link.commandId));
    const recovered: RecoveredDistributedCommandLink[] = [];
    for (const target of toRecoverableTargets(distributedRun)) {
        const link = toRecoveredDistributedCommandLink(target, run);
        if (link && !linkedCommandIds.has(link.commandId)) {
            linkedCommandIds.add(link.commandId);
            recovered.push(link);
        }
    }
    return recovered;
}

/** Absent when the manifest's barrier is disabled. */
export function toDistributedBarrierTimeoutMs(distributedRun: ControlDistributedRunState): number | undefined {
    const barrier = distributedRun.manifest.barrier;
    return barrier.enabled ? barrier.timeoutMs : undefined;
}

function toDistributedStageCommand(target: DistributedRecipeTarget): RallarBlackBoxTestCommand {
    const selection = target.selection;
    const commandId = toDistributedCommandId(target, toDistributedRecipeKey(selection) ?? 'recipe');
    const metadata = toDistributedCommandMetadata(target);
    if (selection.recipe) {
        return {
            kind: 'recipe.load',
            commandId,
            label: `Stage ${selection.recipe.recipeId}`,
            recipe: selection.recipe,
            metadata
        };
    }
    return {
        kind: 'health',
        commandId,
        label: `Preflight ${selection.recipeId ?? 'recipe reference'}`,
        metadata: { ...metadata, recipeReferenceOnly: true }
    };
}

function toDistributedStartCommand(target: DistributedRecipeTarget): RallarBlackBoxTestCommand {
    const selection = target.selection;
    const commandId = toDistributedCommandId(target, toDistributedRecipeKey(selection) ?? 'recipe');
    const metadata = toDistributedCommandMetadata(target);
    return selection.recipe
        ? {
            kind: 'recipe.run',
            commandId,
            label: `Run ${selection.recipe.recipeId}`,
            recipe: selection.recipe,
            metadata
        }
        : { kind: 'recipe.run', commandId, label: `Run ${selection.recipeId ?? 'loaded recipe'}`, metadata };
}

function toRecipePhaseTargets(
    distributedRun: ControlDistributedRunState,
    phase: 'stage' | 'start'
): readonly DistributedRecipeTarget[] {
    return distributedRun.targetAgentIds.flatMap((agentId) =>
        toRecipeSelectionsForAgent(distributedRun, agentId).map((selection) => ({
            distributedRun,
            phase,
            agentId,
            selection
        }))
    );
}

function toRecoverableTargets(distributedRun: ControlDistributedRunState): readonly DistributedPhaseTarget[] {
    const barrierEnabled = distributedRun.manifest.barrier.enabled;
    return distributedRun.targetAgentIds.flatMap((agentId) => [
        ...toRecipeSelectionsForAgent(distributedRun, agentId).flatMap((selection) => [
            { distributedRun, phase: 'stage' as const, agentId, selection },
            { distributedRun, phase: 'start' as const, agentId, selection }
        ]),
        ...(barrierEnabled ? [{ distributedRun, phase: 'barrier' as const, agentId, selection: undefined }] : [])
    ]);
}

function toRecoveredDistributedCommandLink(
    target: DistributedPhaseTarget,
    run: ControlRunState
): RecoveredDistributedCommandLink | undefined {
    const recipeId = target.selection ? toDistributedRecipeKey(target.selection) : undefined;
    const recipeKey = target.phase === 'barrier' ? BARRIER_RECIPE_KEY : recipeId ?? 'recipe';
    const commandId = toDistributedCommandId(target, recipeKey);
    const command = run.commands.get(commandId);
    const result = run.results.get(commandId);
    if (!command && !result) {
        return undefined;
    }
    return {
        phase: target.phase,
        agentId: target.agentId,
        commandId,
        recipeId,
        role: target.selection?.role,
        evidenceQueuedAtEpochMs: command?.queuedAtEpochMs ??
            result?.result?.startedAtEpochMs ??
            result?.result?.endedAtEpochMs
    };
}

function toPhaseCommandTarget(target: DistributedPhaseTarget): Omit<DistributedPhaseCommand, 'command'> {
    return { phase: target.phase, agentId: target.agentId, selection: target.selection };
}

function toDistributedCommandMetadata(
    { distributedRun, phase, agentId, selection }: DistributedPhaseTarget
): RallarBlackBoxTestRecord {
    return {
        distributedRun: {
            distributedRunId: distributedRun.distributedRunId,
            controlRunId: distributedRun.controlRunId,
            phase,
            agentId,
            recipeId: selection ? toDistributedRecipeKey(selection) : undefined,
            role: selection?.role,
            profile: selection?.profile
        }
    };
}

function toBarrierMetadata(distributedRun: ControlDistributedRunState): RallarBlackBoxTestRecord {
    return {
        event: 'barrier.ready',
        expectedAgentIds: [...distributedRun.targetAgentIds],
        timeoutMs: toDistributedBarrierTimeoutMs(distributedRun),
        scheduledStartEpochMs: toScheduledStartEpochMs(distributedRun)
    };
}

function toDistributedCommandId(target: DistributedPhaseTarget, recipeKey: string): string {
    return [
        'distributed',
        toCommandIdSegment(target.distributedRun.distributedRunId, COMMAND_ID_FALLBACK_SEGMENT),
        target.phase,
        toCommandIdSegment(target.agentId, COMMAND_ID_FALLBACK_SEGMENT),
        toCommandIdSegment(recipeKey, COMMAND_ID_FALLBACK_SEGMENT)
    ].join('-');
}

/** Absent unless the manifest schedules its start. */
export function toScheduledStartEpochMs(distributedRun: ControlDistributedRunState): number | undefined {
    const manifest = distributedRun.manifest;
    return manifest.startMode === 'scheduled' ? manifest.startDeadlineEpochMs : undefined;
}
