import type { ControlDistributedRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import {
    distributedRecipeMatches,
    type DistributedRecipeCatalogEntryProjection
} from '@shared-test/rallar-bb-test/distributed-recipe-catalog.ts';
import {
    isDistributedRunTerminalState,
    type RallarBlackBoxDistributedGroupRef,
    type RallarBlackBoxDistributedRunState
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';

export const DEFAULT_EXECUTE_RECIPE_ID = 'rtc-realtime-stability';

export type ExecuteRecipeSelectionIssue = Readonly<{
    code: 'unavailable' | 'ambiguous' | 'default-unavailable';
    message: string;
}>;

export type ExecuteRecipeSelection = Readonly<{
    requestedRecipeId?: string;
    selected?: DistributedRecipeCatalogEntryProjection;
    source: 'explicit' | 'default' | 'none';
    issue?: ExecuteRecipeSelectionIssue;
    urlReplacePatch?: Partial<RecipeConsoleUrlState>;
}>;

export function deriveExecuteRecipeSelection(
    input: Readonly<{
        entries: readonly DistributedRecipeCatalogEntryProjection[];
        recipeId?: string;
    }>
): ExecuteRecipeSelection {
    const requestedRecipeId = input.recipeId ?? DEFAULT_EXECUTE_RECIPE_ID;
    const matches = input.entries.filter((entry) => entry.item.recipe.recipeId === requestedRecipeId);
    const explicit = input.recipeId !== undefined;

    if (matches.length > 1) {
        return {
            requestedRecipeId,
            selected: undefined,
            source: explicit ? 'explicit' : 'none',
            issue: {
                code: 'ambiguous',
                message: `Recipe ${requestedRecipeId} has more than one canonical catalog entry.`
            }
        };
    }
    if (matches.length === 0) {
        return {
            requestedRecipeId,
            selected: undefined,
            source: explicit ? 'explicit' : 'none',
            issue: explicit
                ? {
                    code: 'unavailable',
                    message: `Recipe ${requestedRecipeId} is not available in the repository catalog.`
                }
                : {
                    code: 'default-unavailable',
                    message: `The default recipe ${DEFAULT_EXECUTE_RECIPE_ID} is not available.`
                }
        };
    }

    return {
        requestedRecipeId,
        selected: matches[0],
        source: explicit ? 'explicit' : 'default',
        urlReplacePatch: explicit ? undefined : { recipeId: requestedRecipeId }
    };
}

export function filterExecuteRecipeCatalog(
    input: Readonly<{
        entries: readonly DistributedRecipeCatalogEntryProjection[];
        query: string;
        profile: string;
    }>
): readonly DistributedRecipeCatalogEntryProjection[] {
    return input.entries.filter((entry) => distributedRecipeMatches(entry.item, input.query, input.profile));
}

export function recipeConsoleExecuteRecipeSelectionPatch(
    recipeId: string
): Partial<RecipeConsoleUrlState> {
    return {
        recipeId,
        distributedRunId: undefined,
        commandId: undefined
    };
}

export type ExecuteTargetSelection = Readonly<{
    contextKey: string;
    agentIds: readonly string[];
}>;

export function createExecuteTargetContextKey(
    input: Readonly<{
        controlRunId: string;
        group: RallarBlackBoxDistributedGroupRef;
        recipeId: string;
    }>
): string {
    return JSON.stringify({
        controlRunId: input.controlRunId,
        group: {
            applicationId: input.group.applicationId,
            workspaceId: input.group.workspaceId,
            groupId: input.group.groupId
        },
        recipeId: input.recipeId
    });
}

export function reconcileExecuteTargetSelection(
    input: Readonly<{
        contextKey: string;
        rows: readonly Readonly<{ agentId: string; targetable: boolean; }>[];
        previous?: ExecuteTargetSelection;
    }>
): ExecuteTargetSelection {
    const safeAgentIds = input.rows
        .filter((row) => row.targetable)
        .map((row) => row.agentId);
    const uniqueSafeAgentIds = [...new Set(safeAgentIds)].sort(compareString);
    if (!input.previous || input.previous.contextKey !== input.contextKey) {
        return { contextKey: input.contextKey, agentIds: uniqueSafeAgentIds };
    }
    const safe = new Set(uniqueSafeAgentIds);
    return {
        contextKey: input.contextKey,
        agentIds: [...new Set(input.previous.agentIds)]
            .filter((agentId) => safe.has(agentId))
            .sort(compareString)
    };
}

export function reconcileExecuteRunTruth(
    input: Readonly<{
        distributedRunId?: string;
        optimisticRun?: ControlDistributedRunSnapshot;
        queriedRun?: ControlDistributedRunSnapshot;
    }>
): ControlDistributedRunSnapshot | undefined {
    if (!input.distributedRunId) {
        return undefined;
    }
    const optimistic = matchingRun(
        input.optimisticRun,
        input.distributedRunId
    );
    const queried = matchingRun(input.queriedRun, input.distributedRunId);
    if (!optimistic) {
        return queried;
    }
    if (!queried) {
        return optimistic;
    }
    if (optimistic.updatedAtEpochMs !== queried.updatedAtEpochMs) {
        return optimistic.updatedAtEpochMs > queried.updatedAtEpochMs
            ? optimistic
            : queried;
    }
    const optimisticTerminal = isDistributedRunTerminalState(optimistic.state);
    const queriedTerminal = isDistributedRunTerminalState(queried.state);
    if (optimisticTerminal !== queriedTerminal) {
        return optimisticTerminal ? optimistic : queried;
    }
    if (
        optimisticTerminal && queriedTerminal &&
        Boolean(optimistic.error) !== Boolean(queried.error)
    ) {
        return optimistic.error ? optimistic : queried;
    }
    return optimistic;
}

export type ExecuteMutationAction = 'create' | 'stage' | 'start' | 'cancel';
export type ExecuteMutationClassification = Readonly<{
    ok: boolean;
    run: ControlDistributedRunSnapshot;
    code?: 'terminal-failure' | 'unexpected-state';
    reason?: string;
}>;

const EXPECTED_MUTATION_STATES: Readonly<Record<ExecuteMutationAction, readonly RallarBlackBoxDistributedRunState[]>> =
    {
        create: ['draft'],
        stage: ['waiting-for-ack', 'waiting-for-barrier', 'ready'],
        start: ['running', 'passed'],
        cancel: ['cancelled']
    };

export function classifyExecuteMutationResponse(
    action: ExecuteMutationAction,
    run: ControlDistributedRunSnapshot
): ExecuteMutationClassification {
    if (EXPECTED_MUTATION_STATES[action].includes(run.state)) {
        return { ok: true, run };
    }
    const terminalFailure = run.state === 'failed' || run.state === 'timed-out';
    return {
        ok: false,
        run,
        code: terminalFailure ? 'terminal-failure' : 'unexpected-state',
        reason: run.error?.message ??
            `${
                executeMutationActionLabel(action)
            } returned authoritative state ${run.state}; the action was not completed.`
    };
}

function matchingRun(
    run: ControlDistributedRunSnapshot | undefined,
    distributedRunId: string
): ControlDistributedRunSnapshot | undefined {
    return run?.distributedRunId === distributedRunId ? run : undefined;
}

function executeMutationActionLabel(action: ExecuteMutationAction): string {
    return action.charAt(0).toUpperCase() + action.slice(1);
}

function compareString(left: string, right: string): number {
    return left.localeCompare(right);
}
