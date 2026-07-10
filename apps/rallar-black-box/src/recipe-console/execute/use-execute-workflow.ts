import {
    projectDistributedRecipeCatalog,
} from '@shared-test/rallar-bb-test/distributed-recipe-catalog.ts';
import {
    RALLAR_BLACK_BOX_RTC_REALTIME_DEFAULT_DURATION_SECONDS,
} from '@shared-test/rallar-bb-test/recipe-fixtures.ts';
import { useEffect, useMemo, useState } from 'react';
import type { RecipeConsoleControlConnection } from '../control/ControlConnectionProvider.tsx';
import type { RecipeConsoleControlSelection } from '../control/control-selection.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import {
    createExecuteActionArmContext,
    deriveExecuteActionPolicy,
    type ExecuteArmedAction,
} from './execute-action-policy.ts';
import {
    currentExecuteTargetResolutionEvidence,
    deriveExecuteManifest,
    projectExecuteManifest,
} from './execute-manifest.ts';
import { projectExecuteOperationError } from './execute-operation-error.ts';
import {
    executeConnectionTruth,
    executeOperationContextKey,
    executeRunConfigurationIssue,
    executeSafeTargetLabel,
    executeTruthContextKey,
    manifestRecipeIds,
    singleRunRecipe,
    singleRunRecipeId,
} from './execute-workflow-context.ts';
import {
    deriveExecuteRecipeSelection,
    filterExecuteRecipeCatalog,
    recipeConsoleExecuteRecipeSelectionPatch,
    reconcileExecuteRunTruth,
} from './execute-workflow-state.ts';
import { useExecuteDraft } from './use-execute-draft.ts';
import {
    useExecuteOperations,
    type BoundExecuteOptimisticRun,
    type BoundExecuteResolution,
} from './use-execute-operations.ts';

export function useExecuteWorkflow(input: Readonly<{
    connection: RecipeConsoleControlConnection;
    selection: RecipeConsoleControlSelection;
    urlState: RecipeConsoleUrlState;
    navigate(patch: Partial<RecipeConsoleUrlState>): void;
    replace(patch: Partial<RecipeConsoleUrlState>): void;
}>) {
    const [query, setQuery] = useState('');
    const [profile, setProfile] = useState('');
    const [resolution, setResolution] = useState<BoundExecuteResolution>();
    const [optimisticRun, setOptimisticRun] = useState<BoundExecuteOptimisticRun>();
    const [armedKey, setArmedKey] = useState<string>();
    const group = input.selection.groupContext.group;
    const truthContextKey = executeTruthContextKey({
        baseUrl: input.connection.baseUrl,
        controlRunId: input.selection.controlRunId,
    });
    const run = reconcileExecuteRunTruth({
        distributedRunId: input.urlState.distributedRunId,
        optimisticRun: optimisticRun?.contextKey === truthContextKey
            ? optimisticRun.run
            : undefined,
        queriedRun: input.selection.distributedRun,
    });
    useEffect(() => {
        setOptimisticRun(previous => previous?.contextKey === truthContextKey
            ? previous
            : undefined);
    }, [truthContextKey]);
    const restoredRecipeId = input.urlState.recipeId ?? singleRunRecipeId(run);
    const baseCatalog = useMemo(() => projectDistributedRecipeCatalog({
        configuration: {
            group,
            apiBaseUrl: input.connection.bootstrap.apiBaseUrl,
            rtcRealtimeDurationSeconds:
                RALLAR_BLACK_BOX_RTC_REALTIME_DEFAULT_DURATION_SECONDS,
        },
    }), [
        group.applicationId,
        group.groupId,
        group.workspaceId,
        input.connection.bootstrap.apiBaseUrl,
    ]);
    const catalog = useMemo(() => {
        const storedRecipe = singleRunRecipe(run);
        if (!storedRecipe) return baseCatalog;
        return projectDistributedRecipeCatalog({
            items: baseCatalog.entries.map(entry =>
                entry.item.recipe.recipeId === storedRecipe.recipeId
                    ? { ...entry.item, recipe: storedRecipe }
                    : entry.item
            ),
        });
    }, [baseCatalog, run]);
    const recipeSelection = useMemo(() => deriveExecuteRecipeSelection({
        entries: catalog.entries,
        recipeId: restoredRecipeId,
    }), [catalog.entries, restoredRecipeId]);
    const entries = useMemo(() => filterExecuteRecipeCatalog({
        entries: catalog.entries,
        query,
        profile,
    }), [catalog.entries, profile, query]);
    const connection = executeConnectionTruth(input.connection);
    const draft = useExecuteDraft({
        connection: input.connection,
        selection: input.selection,
        group,
        selectedRecipe: recipeSelection.selected,
        run,
        truthContextKey,
    });

    useEffect(() => {
        const awaitingExplicitRun = input.urlState.distributedRunId && !run &&
            input.connection.query.snapshot?.distributedRuns === undefined;
        if (awaitingExplicitRun) return;
        const runRecipeId = singleRunRecipeId(run);
        if (!input.urlState.recipeId && runRecipeId) {
            input.replace({ recipeId: runRecipeId });
        } else if (recipeSelection.urlReplacePatch) {
            input.replace(recipeSelection.urlReplacePatch);
        }
    }, [
        input.connection.query.snapshot?.distributedRuns,
        input.replace,
        input.urlState.distributedRunId,
        input.urlState.recipeId,
        recipeSelection.urlReplacePatch,
        run,
    ]);
    const distributedRunId = input.urlState.distributedRunId ??
        draft.draftDistributedRunId;
    const selectedAgentIds = draft.selectedAgentIds;
    const targetRows = draft.targetRows;
    const generatedManifest = !run && distributedRunId && input.selection.controlRun &&
            recipeSelection.selected
        ? deriveExecuteManifest({
            distributedRunId,
            controlRunId: input.selection.controlRun.runId,
            group,
            selectedRecipe: recipeSelection.selected,
            selectedAgentIds,
        })
        : undefined;
    const manifest = run ? projectExecuteManifest(run.manifest) : generatedManifest;
    const operationContextKey = manifest
        ? executeOperationContextKey(truthContextKey, manifest.fingerprint)
        : '';
    const currentResolution = manifest
            && resolution?.contextKey === operationContextKey
        ? currentExecuteTargetResolutionEvidence({
            manifest: manifest.manifest,
            evidence: resolution.evidence,
        })
        : undefined;
    const unknownDistributedRunId = Boolean(
        input.urlState.distributedRunId &&
        input.connection.query.snapshot?.distributedRuns &&
        !run,
    );
    const configurationIssue = executeRunConfigurationIssue({
        run,
        controlRunId: input.selection.controlRunId,
        recipeId: recipeSelection.selected?.item.recipe.recipeId,
    });
    const armContexts = useMemo(() => {
        const controlRunId = manifest?.manifest.controlRunId;
        if (!manifest || !controlRunId) return {};
        return Object.fromEntries((['create', 'stage', 'start', 'cancel'] as const)
            .map(action => [action, createExecuteActionArmContext({
                action,
                controlBaseUrl: input.connection.baseUrl,
                controlRunId,
                distributedRunId: manifest.manifest.distributedRunId,
                recipeIds: manifestRecipeIds(manifest.manifest),
                targetAgentIds: selectedAgentIds,
                manifestFingerprint: manifest.fingerprint,
            })]));
    }, [
        input.connection.baseUrl,
        manifest,
        selectedAgentIds,
    ]);
    const selectedTargetsSafe = selectedAgentIds.length > 0 &&
        selectedAgentIds.every(agentId =>
            targetRows.some(row => row.agentId === agentId && row.targetable)
        );
    const policyFacts = {
        connection,
        runState: run?.state,
        hasKnownRun: run !== undefined,
        unknownDistributedRunId,
        recipeAvailable: recipeSelection.selected !== undefined && !configurationIssue,
        schemaValid: recipeSelection.selected?.schema.ok === true,
        preflightValid: recipeSelection.selected?.preflight.errors.length === 0,
        selectedTargetsSafe,
        manifestValid: manifest?.validation.ok === true,
        resolutionCurrent: currentResolution?.comparison.ok === true,
        armKeys: Object.fromEntries(Object.entries(armContexts)
            .map(([action, value]) => [action, value.key])),
        armedKey,
    } as const;
    const idlePolicy = deriveExecuteActionPolicy({
        ...policyFacts,
        busyAction: undefined,
    });
    const operations = useExecuteOperations({
        connection: input.connection,
        manifest,
        run,
        policy: idlePolicy,
        operationContextKey,
        truthContextKey,
        navigate: input.navigate,
        setResolution,
        setOptimisticRun,
        resetArming: () => setArmedKey(undefined),
    });
    const policy = operations.busyAction
        ? deriveExecuteActionPolicy({
            ...policyFacts,
            busyAction: operations.busyAction,
        })
        : idlePolicy;

    useEffect(() => {
        const currentKeys = new Set(Object.values(armContexts).map(value => value.key));
        if (armedKey && !currentKeys.has(armedKey)) setArmedKey(undefined);
    }, [armContexts, armedKey]);
    function arm(action: ExecuteArmedAction): void {
        const context = armContexts[action];
        if (context) setArmedKey(value => value === context.key ? undefined : context.key);
    }

    return {
        catalog: { entries, profiles: catalog.profiles, query, profile, selection: recipeSelection },
        targetRows,
        selectedAgentIds,
        connection,
        manifest,
        resolution: currentResolution,
        run,
        unknownDistributedRunId,
        mutationError: operations.mutationError ?? (configurationIssue
            ? projectExecuteOperationError(new Error(configurationIssue))
            : undefined),
        policy,
        armContexts,
        armedKey,
        busyAction: operations.busyAction,
        selectionLocked: run !== undefined || operations.busyAction !== undefined,
        cancelOpen: operations.cancelOpen,
        safeTargetLabel: executeSafeTargetLabel({
            connection,
            rows: targetRows,
            selectedAgentIds,
        }),
        setQuery,
        setProfile,
        selectRecipe: (recipeId: string) => input.navigate(
            recipeConsoleExecuteRecipeSelectionPatch(recipeId),
        ),
        toggleTarget: draft.toggleTarget,
        arm,
        resolveTargets: operations.resolveTargets,
        createRun: operations.createRun,
        stageRun: operations.stageRun,
        startRun: operations.startRun,
        requestCancel: operations.requestCancel,
        closeCancel: operations.closeCancel,
        confirmCancel: operations.confirmCancel,
        refresh: operations.refresh,
        exportArtifact: operations.exportArtifact,
    } as const;
}
