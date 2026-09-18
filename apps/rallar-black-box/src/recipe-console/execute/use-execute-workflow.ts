import { projectDistributedRecipeCatalog } from '@shared-test/rallar-bb-test/distributed-recipe-catalog.ts';
import { RALLAR_BLACK_BOX_RTC_REALTIME_DEFAULT_DURATION_SECONDS } from '@shared-test/rallar-bb-test/fixtures/rtc-realtime-recipes.ts';
import { useEffect, useMemo, useState } from 'react';
import type { RecipeConsoleControlSelection } from '../control/control-selection.ts';
import type { RecipeConsoleControlConnection } from '../control/ControlConnectionProvider.tsx';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import { deriveExecuteActionPolicy } from './execute-action-policy.ts';
import {
    createExecuteManifestDraft,
    resolveExecuteTargetResolutionEvidence,
    toExecuteManifestDraft
} from './execute-manifest.ts';
import { deriveExecuteNextAction } from './execute-next-action.ts';
import { projectExecuteOperationError } from './execute-operation-error.ts';
import {
    resolveExecuteConnectionTruth,
    resolveExecuteRunConfigurationIssue,
    resolveSingleRunRecipe,
    resolveSingleRunRecipeId,
    toExecuteOperationContextKey,
    toExecuteSafeTargetLabel,
    toExecuteTruthContextKey
} from './execute-workflow-context.ts';
import {
    deriveExecuteRecipeSelection,
    filterExecuteRecipeCatalog,
    recipeConsoleExecuteRecipeSelectionPatch,
    reconcileExecuteRunTruth
} from './execute-workflow-state.ts';
import { useExecuteAgentLaunch } from './use-execute-agent-launch.ts';
import { useExecuteDraft } from './use-execute-draft.ts';
import {
    useExecuteOperations,
    type BoundExecuteOptimisticRun,
    type BoundExecuteResolution
} from './use-execute-operations.ts';

export function useExecuteWorkflow(
    input: Readonly<{
        connection: RecipeConsoleControlConnection;
        selection: RecipeConsoleControlSelection;
        urlState: RecipeConsoleUrlState;
        navigate(patch: Partial<RecipeConsoleUrlState>): void;
        replace(patch: Partial<RecipeConsoleUrlState>): void;
    }>
) {
    const [query, setQuery] = useState('');
    const [profile, setProfile] = useState('');
    const [resolution, setResolution] = useState<BoundExecuteResolution>();
    const [optimisticRun, setOptimisticRun] = useState<BoundExecuteOptimisticRun>();
    const group = input.selection.groupContext.group;
    const truthContextKey = toExecuteTruthContextKey({
        baseUrl: input.connection.baseUrl,
        controlRunId: input.selection.controlRunId
    });
    const run = reconcileExecuteRunTruth({
        distributedRunId: input.urlState.distributedRunId,
        optimisticRun: optimisticRun?.contextKey === truthContextKey
            ? optimisticRun.run
            : undefined,
        queriedRun: input.selection.distributedRun
    });
    useEffect(() => {
        setOptimisticRun((previous) =>
            previous?.contextKey === truthContextKey
                ? previous
                : undefined
        );
    }, [truthContextKey]);
    const restoredRecipeId = input.urlState.recipeId ?? resolveSingleRunRecipeId(run);
    const baseCatalog = useMemo(() =>
        projectDistributedRecipeCatalog({
            configuration: {
                group,
                apiBaseUrl: input.connection.bootstrap.apiBaseUrl,
                rtcRealtimeDurationSeconds: RALLAR_BLACK_BOX_RTC_REALTIME_DEFAULT_DURATION_SECONDS
            }
        }), [
        group.applicationId,
        group.groupId,
        group.workspaceId,
        input.connection.bootstrap.apiBaseUrl
    ]);
    const catalog = useMemo(() => {
        const storedRecipe = resolveSingleRunRecipe(run);
        if (!storedRecipe) {
            return baseCatalog;
        }
        return projectDistributedRecipeCatalog({
            items: baseCatalog.entries.map((entry) =>
                entry.item.recipe.recipeId === storedRecipe.recipeId
                    ? { ...entry.item, recipe: storedRecipe }
                    : entry.item
            )
        });
    }, [baseCatalog, run]);
    const recipeSelection = useMemo(() =>
        deriveExecuteRecipeSelection({
            entries: catalog.entries,
            recipeId: restoredRecipeId
        }), [catalog.entries, restoredRecipeId]);
    const entries = useMemo(() =>
        filterExecuteRecipeCatalog({
            entries: catalog.entries,
            query,
            profile
        }), [catalog.entries, profile, query]);
    const connection = resolveExecuteConnectionTruth(input.connection);
    const draft = useExecuteDraft({
        connection: input.connection,
        selection: input.selection,
        group,
        selectedRecipe: recipeSelection.selected,
        run,
        truthContextKey
    });

    useEffect(() => {
        const awaitingExplicitRun = input.urlState.distributedRunId && !run &&
            input.connection.query.snapshot?.distributedRuns === undefined;
        if (awaitingExplicitRun) {
            return;
        }
        const runRecipeId = resolveSingleRunRecipeId(run);
        if (!input.urlState.recipeId && runRecipeId) {
            input.replace({ recipeId: runRecipeId });
        }
        else if (recipeSelection.urlReplacePatch) {
            input.replace(recipeSelection.urlReplacePatch);
        }
    }, [
        input.connection.query.snapshot?.distributedRuns,
        input.replace,
        input.urlState.distributedRunId,
        input.urlState.recipeId,
        recipeSelection.urlReplacePatch,
        run
    ]);
    const distributedRunId = input.urlState.distributedRunId ??
        draft.draftDistributedRunId;
    const selectedAgentIds = draft.selectedAgentIds;
    const targetRows = draft.targetRows;
    const generatedManifest = !run && distributedRunId && input.selection.controlRun &&
            recipeSelection.selected
        ? createExecuteManifestDraft({
            distributedRunId,
            controlRunId: input.selection.controlRun.runId,
            group,
            selectedRecipe: recipeSelection.selected,
            selectedAgentIds
        })
        : undefined;
    const requestedManifest = run ? toExecuteManifestDraft(run.manifest) : generatedManifest;
    const manifest = requestedManifest?.right;
    const operationContextKey = manifest
        ? toExecuteOperationContextKey(truthContextKey, manifest.fingerprint)
        : '';
    const currentResolution = manifest &&
            resolution?.contextKey === operationContextKey
        ? resolveExecuteTargetResolutionEvidence({
            manifestFingerprint: manifest.fingerprint,
            evidence: resolution.evidence
        })
        : undefined;
    const unknownDistributedRunId = Boolean(
        input.urlState.distributedRunId &&
            input.connection.query.snapshot?.distributedRuns &&
            !run
    );
    const configurationIssue = resolveExecuteRunConfigurationIssue({
        run,
        controlRunId: input.selection.controlRunId,
        recipeId: recipeSelection.selected?.item.recipe.recipeId
    });
    const workflowIssue = configurationIssue ?? requestedManifest?.left ?? draft.draftIssue;
    const selectedTargetsSafe = selectedAgentIds.length > 0 &&
        selectedAgentIds.every((agentId) => targetRows.some((row) => row.agentId === agentId && row.targetable));
    const policyFacts = {
        connection,
        runState: run?.state,
        hasKnownRun: run !== undefined,
        unknownDistributedRunId,
        recipeAvailable: recipeSelection.selected !== undefined && !configurationIssue,
        schemaValid: recipeSelection.selected?.schema.ok === true,
        preflightValid: recipeSelection.selected?.preflight.errors.length === 0,
        selectedTargetsSafe,
        manifestValid: manifest?.validationIssues.length === 0,
        resolutionCurrent: currentResolution?.comparison.ok === true
    } as const;
    const idlePolicy = deriveExecuteActionPolicy({
        ...policyFacts,
        busyAction: undefined
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
        setOptimisticRun
    });
    const policy = operations.busyAction
        ? deriveExecuteActionPolicy({
            ...policyFacts,
            busyAction: operations.busyAction
        })
        : idlePolicy;

    const selectionLocked = run !== undefined || operations.busyAction !== undefined;
    const agentLaunch = useExecuteAgentLaunch({
        connection: input.connection,
        controlRunId: input.selection.controlRunId,
        group,
        targetRows,
        selectedAgentIds,
        selectionLocked,
        onBindRunId: (controlRunId) =>
            input.navigate({
                controlRunId,
                distributedRunId: undefined,
                commandId: undefined
            }),
        onSelectTargets: draft.setSelectedTargets
    });
    const nextAction = deriveExecuteNextAction({
        connection,
        policy,
        runState: run?.state,
        targetCount: selectedAgentIds.length,
        targetableCount: targetRows.filter((row) => row.targetable).length,
        launchedExpectedCount: agentLaunch.launchedExpectedCount,
        launchedReadyCount: agentLaunch.launchedReadyCount,
        launchPreparationPending: agentLaunch.launchPreparationPending,
        launchedCohortSelectionPending: agentLaunch.launchedCohortSelectionPending,
        ackReadyCount: run?.rollup.summary.readyParticipants,
        ackExpectedCount: run?.targetAgentIds.length
    });

    return {
        catalog: { entries, profiles: catalog.profiles, query, profile, selection: recipeSelection },
        targetRows,
        selectedAgentIds,
        connection,
        manifest,
        resolution: currentResolution,
        run,
        unknownDistributedRunId,
        mutationError: operations.mutationError ?? (workflowIssue
            ? projectExecuteOperationError(new Error(workflowIssue))
            : undefined),
        policy,
        agentLaunch,
        nextAction,
        busyAction: operations.busyAction,
        selectionLocked,
        startOpen: operations.startOpen,
        cancelOpen: operations.cancelOpen,
        safeTargetLabel: toExecuteSafeTargetLabel({
            connection,
            rows: targetRows,
            selectedAgentIds
        }),
        setQuery,
        setProfile,
        selectRecipe: (recipeId: string) =>
            input.navigate(
                recipeConsoleExecuteRecipeSelectionPatch(recipeId)
            ),
        toggleTarget: draft.toggleTarget,
        resolveTargets: operations.resolveTargets,
        createRun: operations.createRun,
        stageRun: operations.stageRun,
        requestStart: operations.requestStart,
        closeStart: operations.closeStart,
        confirmStart: operations.startRun,
        requestCancel: operations.requestCancel,
        closeCancel: operations.closeCancel,
        confirmCancel: operations.confirmCancel,
        refresh: operations.refresh,
        exportArtifact: operations.exportArtifact
    } as const;
}
