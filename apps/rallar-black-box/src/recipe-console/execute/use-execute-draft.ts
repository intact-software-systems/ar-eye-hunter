import type { ControlDistributedRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type { DistributedRecipeCatalogEntryProjection } from '@shared-test/rallar-bb-test/distributed-recipe-catalog.ts';
import { distributedRecipeTargetRows } from '@shared-test/rallar-bb-test/distributed-recipe-targeting/distributed-recipe-target-rows.ts';
import type { RallarBlackBoxDistributedGroupRef } from '@shared-test/rallar-bb-test/distributed-run.ts';
import type { Either } from '@shared/resilience/Either.ts';
import { useEffect, useMemo, useState } from 'react';
import type { RecipeConsoleControlSelection } from '../control/control-selection.ts';
import type { RecipeConsoleControlConnection } from '../control/ControlConnectionProvider.tsx';
import { createExecuteDistributedRunId } from './execute-manifest.ts';
import { isSameTargetSelection, resolveAuthoritativeTargetIds } from './execute-workflow-context.ts';
import {
    createExecuteTargetContextKey,
    reconcileExecuteTargetSelection,
    type ExecuteTargetSelection
} from './execute-workflow-state.ts';

type DraftIdentity = Readonly<{
    contextKey: string;
    requestedRunId: Either<string, string>;
}>;

export function useExecuteDraft(
    input: Readonly<{
        connection: RecipeConsoleControlConnection;
        selection: RecipeConsoleControlSelection;
        group: RallarBlackBoxDistributedGroupRef;
        /** Absent while the operator has selected no recipe. */
        selectedRecipe?: DistributedRecipeCatalogEntryProjection;
        /** Absent while the console has no created distributed run, so targets stay editable. */
        run?: ControlDistributedRunSnapshot;
        truthContextKey: string;
    }>
) {
    const [targetSelection, setTargetSelection] = useState<ExecuteTargetSelection>();
    const [draftIdentity, setDraftIdentity] = useState<DraftIdentity>();
    const targetRows = useMemo(() =>
        input.selectedRecipe
            ? distributedRecipeTargetRows({
                run: input.selection.controlRun,
                group: input.group,
                requiredCommandKinds: input.selectedRecipe.commandKinds,
                requiredRecipes: [input.selectedRecipe.item.recipe],
                nowEpochMs: input.connection.query.receivedAtEpochMs ?? Date.now()
            })
            : [], [
        input.connection.query.receivedAtEpochMs,
        input.group.applicationId,
        input.group.groupId,
        input.group.workspaceId,
        input.selectedRecipe,
        input.selection.controlRun
    ]);
    const targetContextKey = input.selection.controlRun && input.selectedRecipe
        ? createExecuteTargetContextKey({
            controlRunId: input.selection.controlRun.runId,
            group: input.group,
            recipeId: input.selectedRecipe.item.recipe.recipeId
        })
        : '';
    const reconciledTargets = useMemo(() =>
        targetContextKey
            ? reconcileExecuteTargetSelection({
                contextKey: targetContextKey,
                rows: targetRows,
                previous: targetSelection
            })
            : { contextKey: '', agentIds: [] }, [targetContextKey, targetRows, targetSelection]);
    const draftContextKey = targetContextKey
        ? `${input.truthContextKey}\n${targetContextKey}`
        : '';

    useEffect(() => {
        if (!isSameTargetSelection(targetSelection, reconciledTargets)) {
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
        const recipeId = input.selectedRecipe.item.recipe.recipeId;
        setDraftIdentity((previous) =>
            previous?.contextKey === draftContextKey
                ? previous
                : {
                    contextKey: draftContextKey,
                    requestedRunId: createExecuteDistributedRunId({
                        controlRunId,
                        group: input.group,
                        recipeId,
                        requestedAtEpochMs: Date.now()
                    })
                }
        );
    }, [
        draftContextKey,
        input.group,
        input.run,
        input.selectedRecipe,
        input.selection.controlRun
    ]);

    function toggleTarget(agentId: string): void {
        if (input.run) {
            return;
        }
        const selected = new Set(reconciledTargets.agentIds);
        selected.has(agentId) ? selected.delete(agentId) : selected.add(agentId);
        setTargetSelection({
            contextKey: reconciledTargets.contextKey,
            agentIds: [...selected].sort()
        });
    }

    function setSelectedTargets(agentIds: readonly string[]): void {
        if (input.run || !reconciledTargets.contextKey) {
            return;
        }
        const targetable = new Set(
            targetRows.filter((row) => row.targetable).map((row) => row.agentId)
        );
        setTargetSelection({
            contextKey: reconciledTargets.contextKey,
            agentIds: [...new Set(agentIds)]
                .filter((agentId) => targetable.has(agentId))
                .sort()
        });
    }

    const requestedRunId = draftIdentity !== undefined &&
            draftIdentity.contextKey === draftContextKey
        ? draftIdentity.requestedRunId
        : undefined;

    return {
        targetRows,
        selectedAgentIds: input.run
            ? resolveAuthoritativeTargetIds(input.run)
            : reconciledTargets.agentIds,
        draftDistributedRunId: requestedRunId?.right,
        draftIssue: requestedRunId?.left,
        toggleTarget,
        setSelectedTargets
    } as const;
}
