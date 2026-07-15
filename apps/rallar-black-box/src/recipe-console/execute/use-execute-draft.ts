import type { ControlDistributedRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type { DistributedRecipeCatalogEntryProjection } from '@shared-test/rallar-bb-test/distributed-recipe-catalog.ts';
import { distributedRecipeTargetRows } from '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import type { RallarBlackBoxDistributedGroupRef } from '@shared-test/rallar-bb-test/distributed-run.ts';
import { useEffect, useMemo, useState } from 'react';
import type { RecipeConsoleControlConnection } from '../control/ControlConnectionProvider.tsx';
import type { RecipeConsoleControlSelection } from '../control/control-selection.ts';
import { createExecuteDistributedRunId } from './execute-manifest.ts';
import {
    authoritativeTargetIds,
    sameTargetSelection,
} from './execute-workflow-context.ts';
import {
    createExecuteTargetContextKey,
    reconcileExecuteTargetSelection,
    type ExecuteTargetSelection,
} from './execute-workflow-state.ts';

type DraftIdentity = Readonly<{
    contextKey: string;
    distributedRunId: string;
}>;

export function useExecuteDraft(input: Readonly<{
    connection: RecipeConsoleControlConnection;
    selection: RecipeConsoleControlSelection;
    group: RallarBlackBoxDistributedGroupRef;
    selectedRecipe?: DistributedRecipeCatalogEntryProjection;
    run?: ControlDistributedRunSnapshot;
    truthContextKey: string;
}>) {
    const [targetSelection, setTargetSelection] = useState<ExecuteTargetSelection>();
    const [draftIdentity, setDraftIdentity] = useState<DraftIdentity>();
    const targetRows = useMemo(() => input.selectedRecipe
        ? distributedRecipeTargetRows({
            run: input.selection.controlRun,
            group: input.group,
            requiredCommandKinds: input.selectedRecipe.commandKinds,
            requiredRecipes: [input.selectedRecipe.item.recipe],
            nowEpochMs: input.connection.query.receivedAtEpochMs ?? Date.now(),
        })
        : [], [
        input.connection.query.receivedAtEpochMs,
        input.group.applicationId,
        input.group.groupId,
        input.group.workspaceId,
        input.selectedRecipe,
        input.selection.controlRun,
    ]);
    const targetContextKey = input.selection.controlRun && input.selectedRecipe
        ? createExecuteTargetContextKey({
            controlRunId: input.selection.controlRun.runId,
            group: input.group,
            recipeId: input.selectedRecipe.item.recipe.recipeId,
        })
        : '';
    const reconciledTargets = useMemo(() => targetContextKey
        ? reconcileExecuteTargetSelection({
            contextKey: targetContextKey,
            rows: targetRows,
            previous: targetSelection,
        })
        : { contextKey: '', agentIds: [] }, [targetContextKey, targetRows, targetSelection]);
    const draftContextKey = targetContextKey
        ? `${input.truthContextKey}\n${targetContextKey}`
        : '';

    useEffect(() => {
        if (!sameTargetSelection(targetSelection, reconciledTargets)) {
            setTargetSelection(reconciledTargets);
        }
    }, [reconciledTargets, targetSelection]);
    useEffect(() => {
        if (
            input.run || !draftContextKey ||
            !input.selection.controlRun || !input.selectedRecipe
        ) {
            setDraftIdentity(undefined);
            return;
        }
        const controlRunId = input.selection.controlRun.runId;
        setDraftIdentity(previous => previous?.contextKey === draftContextKey
            ? previous
            : {
                contextKey: draftContextKey,
                distributedRunId: createExecuteDistributedRunId({
                    controlRunId,
                    group: input.group,
                    recipeId: input.selectedRecipe!.item.recipe.recipeId,
                    requestedAtEpochMs: Date.now(),
                }),
            });
    }, [
        draftContextKey,
        input.group,
        input.run,
        input.selectedRecipe,
        input.selection.controlRun,
    ]);

    function toggleTarget(agentId: string): void {
        if (input.run) return;
        const selected = new Set(reconciledTargets.agentIds);
        selected.has(agentId) ? selected.delete(agentId) : selected.add(agentId);
        setTargetSelection({
            contextKey: reconciledTargets.contextKey,
            agentIds: [...selected].sort(),
        });
    }

    function selectTargets(agentIds: readonly string[]): void {
        if (input.run || !reconciledTargets.contextKey) return;
        const targetable = new Set(
            targetRows.filter(row => row.targetable).map(row => row.agentId),
        );
        setTargetSelection({
            contextKey: reconciledTargets.contextKey,
            agentIds: [...new Set(agentIds)]
                .filter(agentId => targetable.has(agentId))
                .sort(),
        });
    }

    return {
        targetRows,
        selectedAgentIds: input.run
            ? authoritativeTargetIds(input.run)
            : reconciledTargets.agentIds,
        draftDistributedRunId: draftIdentity?.contextKey === draftContextKey
            ? draftIdentity.distributedRunId
            : undefined,
        toggleTarget,
        selectTargets,
    } as const;
}
