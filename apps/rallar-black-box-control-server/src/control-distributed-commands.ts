import type {
    ControlDistributedRunCommandLink,
    ControlDistributedRunCommandPhase
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import {
    type RallarBlackBoxDistributedRunRecipeSelection
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import type {
    RallarBlackBoxTestCommand
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { toDistributedRecipeKey } from './control-distributed-targeting.ts';
import type { ControlDistributedRunState, ControlRunState } from './control-service-state.ts';

interface DistributedCommandMetadataInput {
    readonly distributedRun: ControlDistributedRunState;
    readonly phase: ControlDistributedRunCommandPhase;
    readonly agentId: string;
    readonly selection: RallarBlackBoxDistributedRunRecipeSelection | undefined;
}
interface DistributedCommandIdentityInput {
    readonly distributedRun: ControlDistributedRunState;
    readonly phase: ControlDistributedRunCommandPhase;
    readonly agentId: string;
    readonly recipeKey: string;
}
export function toDistributedStageCommand(
    distributedRun: ControlDistributedRunState,
    agentId: string,
    selection: RallarBlackBoxDistributedRunRecipeSelection
): RallarBlackBoxTestCommand {
    const commandId = toDistributedCommandId({
        distributedRun,
        phase: 'stage',
        agentId,
        recipeKey: toDistributedRecipeKey(selection) ?? 'recipe'
    });
    if (selection.recipe) {
        return {
            kind: 'recipe.load',
            commandId,
            label: `Stage ${selection.recipe.recipeId}`,
            recipe: selection.recipe,
            metadata: toDistributedCommandMetadata({
                distributedRun,
                phase: 'stage',
                agentId,
                selection
            })
        };
    }

    return {
        kind: 'health',
        commandId,
        label: `Preflight ${selection.recipeId ?? 'recipe reference'}`,
        metadata: {
            ...toDistributedCommandMetadata({
                distributedRun,
                phase: 'stage',
                agentId,
                selection
            }),
            recipeReferenceOnly: true
        }
    };
}
export function toDistributedStartCommand(
    distributedRun: ControlDistributedRunState,
    agentId: string,
    selection: RallarBlackBoxDistributedRunRecipeSelection
): RallarBlackBoxTestCommand {
    const commandId = toDistributedCommandId({
        distributedRun,
        phase: 'start',
        agentId,
        recipeKey: toDistributedRecipeKey(selection) ?? 'recipe'
    });
    return selection.recipe
        ? {
            kind: 'recipe.run',
            commandId,
            label: `Run ${selection.recipe.recipeId}`,
            recipe: selection.recipe,
            metadata: toDistributedCommandMetadata({
                distributedRun,
                phase: 'start',
                agentId,
                selection
            })
        }
        : {
            kind: 'recipe.run',
            commandId,
            label: `Run ${selection.recipeId ?? 'loaded recipe'}`,
            metadata: toDistributedCommandMetadata({
                distributedRun,
                phase: 'start',
                agentId,
                selection
            })
        };
}
export function toDistributedBarrierCommand(
    distributedRun: ControlDistributedRunState,
    agentId: string
): RallarBlackBoxTestCommand {
    const commandId = toDistributedCommandId({
        distributedRun,
        phase: 'barrier',
        agentId,
        recipeKey: 'ready'
    });
    return {
        kind: 'health',
        commandId,
        label: `Barrier ready ${distributedRun.distributedRunId}`,
        metadata: {
            ...toDistributedCommandMetadata({
                distributedRun,
                phase: 'barrier',
                agentId,
                selection: undefined
            }),
            barrier: {
                event: 'barrier.ready',
                expectedAgentIds: [...distributedRun.targetAgentIds],
                timeoutMs: toDistributedBarrierTimeoutMs(distributedRun),
                scheduledStartEpochMs: distributedRun.manifest.startMode === 'scheduled'
                    ? distributedRun.manifest.startDeadlineEpochMs
                    : undefined
            }
        }
    };
}
export function toDistributedCommandMetadata(
    { distributedRun, phase, agentId, selection }: DistributedCommandMetadataInput
): Readonly<Record<string, unknown>> {
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
export function toDistributedCommandId(
    { distributedRun, phase, agentId, recipeKey }: DistributedCommandIdentityInput
): string {
    return [
        'distributed',
        safeCommandIdSegment(distributedRun.distributedRunId),
        phase,
        safeCommandIdSegment(agentId),
        safeCommandIdSegment(recipeKey)
    ].join('-');
}
export function toDistributedBarrierTimeoutMs(distributedRun: ControlDistributedRunState): number {
    const timeoutMs = distributedRun.manifest.barrier?.timeoutMs;
    return typeof timeoutMs === 'number' && Number.isInteger(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : distributedRun.manifest.ackTimeoutMs ?? DEFAULT_DISTRIBUTED_BARRIER_TIMEOUT_MS;
}
export function safeCommandIdSegment(value: string): string {
    return value.trim().replace(/[^A-Za-z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '') ||
        'segment';
}
const DEFAULT_DISTRIBUTED_BARRIER_TIMEOUT_MS = 15_000;
export interface ReconcileDistributedCommandInput {
    readonly distributedRun: ControlDistributedRunState;
    readonly run: ControlRunState;
    readonly phase: ControlDistributedRunCommandPhase;
    readonly agentId: string;
    readonly selection: RallarBlackBoxDistributedRunRecipeSelection | undefined;
}

export function toRecoveredDistributedCommandLink(
    { distributedRun, run, phase, agentId, selection }: ReconcileDistributedCommandInput
): ControlDistributedRunCommandLink | undefined {
    const recipeId = selection ? toDistributedRecipeKey(selection) : undefined;
    const commandId = phase === 'barrier'
        ? toDistributedCommandId({
            distributedRun,
            phase,
            agentId,
            recipeKey: 'ready'
        })
        : toDistributedCommandId({
            distributedRun,
            phase,
            agentId,
            recipeKey: recipeId ?? 'recipe'
        });
    if (distributedRun.commandLinks.some((link) => link.commandId === commandId)) {
        return;
    }

    const command = run.commands.get(commandId);
    const result = run.results.get(commandId);
    if (!command && !result) {
        return;
    }

    const queuedAtEpochMs = command?.queuedAtEpochMs ??
        result?.result?.startedAtEpochMs ??
        result?.result?.endedAtEpochMs ??
        distributedRun.updatedAtEpochMs;
    return {
        phase,
        agentId,
        commandId,
        recipeId,
        role: selection?.role,
        queuedAtEpochMs
    };
}
