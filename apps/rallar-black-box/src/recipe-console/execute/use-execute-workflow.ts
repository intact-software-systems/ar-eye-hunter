import {
    useEffect,
    useMemo,
    useState,
    type Dispatch,
    type SetStateAction
} from 'react';

import type { ControlDistributedRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { projectDistributedRecipeCatalog } from '@shared-test/rallar-bb-test/distributed-recipe-catalog.ts';
import type {
    DistributedRecipeCatalogEntryProjection,
    DistributedRecipeCatalogProjection
} from '@shared-test/rallar-bb-test/distributed-recipe-catalog.ts';
import { RALLAR_BLACK_BOX_RTC_REALTIME_DEFAULT_DURATION_SECONDS } from '@shared-test/rallar-bb-test/fixtures/rtc-realtime-recipes.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

import { projectControlOperationError, type ControlOperationError } from '../control/control-operation-error.ts';
import type { RecipeConsoleControlSelection } from '../control/control-selection.ts';
import type { RecipeConsoleControlConnection } from '../control/ControlConnectionProvider.tsx';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import { useExecuteAgentLaunch, type ExecuteAgentLaunchModel } from './agent-launch/use-execute-agent-launch.ts';
import {
    deriveExecuteActionPolicy,
    type ExecuteActionPolicy,
    type ExecuteActionPolicyInput,
    type ExecuteConnectionTruth
} from './execute-action-policy.ts';
import {
    createExecuteManifestDraft,
    resolveExecuteTargetResolutionEvidence,
    toExecuteManifestDraft,
    type ExecuteManifestDraft,
    type ExecuteTargetResolutionEvidence
} from './execute-manifest.ts';
import { deriveExecuteNextAction, type ExecuteNextAction } from './execute-next-action.ts';
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
    reconcileExecuteRunTruth,
    type ExecuteRecipeSelection
} from './execute-workflow-state.ts';
import { useExecuteDraft } from './use-execute-draft.ts';
import {
    useExecuteOperations,
    type BoundExecuteOptimisticRun,
    type BoundExecuteResolution
} from './use-execute-operations.ts';

export interface ExecuteWorkflowInput {
    readonly connection: RecipeConsoleControlConnection;
    readonly selection: RecipeConsoleControlSelection;
    readonly urlState: RecipeConsoleUrlState;
    navigate(patch: Partial<RecipeConsoleUrlState>): void;
    replace(patch: Partial<RecipeConsoleUrlState>): void;
}

export interface ExecuteWorkflow extends
    Pick<
        ReturnType<typeof useExecuteOperations>,
        | 'busyAction'
        | 'startOpen'
        | 'cancelOpen'
        | 'resolveTargets'
        | 'createRun'
        | 'stageRun'
        | 'refresh'
        | 'exportArtifact'
    > {
    readonly catalog: ExecuteCatalogView;
    readonly targetRows: ReturnType<typeof useExecuteDraft>['targetRows'];
    readonly selectedAgentIds: readonly string[];
    readonly connection: ExecuteConnectionTruth;
    readonly manifest: ExecuteManifestDraft | undefined;
    readonly resolution: ExecuteTargetResolutionEvidence | undefined;
    readonly run: ControlDistributedRunSnapshot | undefined;
    readonly unknownDistributedRunId: boolean;
    readonly mutationError: ControlOperationError | undefined;
    readonly policy: ExecuteActionPolicy;
    readonly agentLaunch: ExecuteAgentLaunchModel;
    readonly nextAction: ExecuteNextAction;
    readonly selectionLocked: boolean;
    readonly rtcCaptureMode: RtcSignalingDiagnostics.CaptureMode | undefined;
    readonly setRtcCaptureMode: Dispatch<SetStateAction<RtcSignalingDiagnostics.CaptureMode | undefined>>;
    readonly safeTargetLabel: string;
    readonly setQuery: Dispatch<SetStateAction<string>>;
    readonly setProfile: Dispatch<SetStateAction<string>>;
    selectRecipe(recipeId: string): void;
    readonly toggleTarget: ReturnType<typeof useExecuteDraft>['toggleTarget'];
    readonly requestStart: ReturnType<typeof useExecuteOperations>['requestStart'];
    readonly closeStart: ReturnType<typeof useExecuteOperations>['closeStart'];
    readonly confirmStart: ReturnType<typeof useExecuteOperations>['startRun'];
    readonly requestCancel: ReturnType<typeof useExecuteOperations>['requestCancel'];
    readonly closeCancel: ReturnType<typeof useExecuteOperations>['closeCancel'];
    readonly confirmCancel: ReturnType<typeof useExecuteOperations>['confirmCancel'];
}

interface ExecuteCatalogView {
    readonly entries: readonly DistributedRecipeCatalogEntryProjection[];
    readonly profiles: DistributedRecipeCatalogProjection['profiles'];
    readonly query: string;
    readonly profile: string;
    readonly selection: ExecuteRecipeSelection;
}

interface ExecuteCatalogState extends ExecuteCatalogView {
    readonly setQuery: Dispatch<SetStateAction<string>>;
    readonly setProfile: Dispatch<SetStateAction<string>>;
}

interface ExecuteRunTruth {
    readonly truthContextKey: string;
    readonly run: ControlDistributedRunSnapshot | undefined;
    readonly setOptimisticRun: Dispatch<SetStateAction<BoundExecuteOptimisticRun | undefined>>;
}

interface ExecuteManifestIntent {
    readonly draft: ReturnType<typeof useExecuteDraft>;
    readonly manifest: ExecuteManifestDraft | undefined;
    readonly currentResolution: ExecuteTargetResolutionEvidence | undefined;
    readonly operationContextKey: string;
    readonly unknownDistributedRunId: boolean;
    readonly configurationIssue: string | undefined;
    readonly recipeSelection: ExecuteRecipeSelection;
    readonly workflowIssue: string | undefined;
    readonly rtcCaptureMode: RtcSignalingDiagnostics.CaptureMode | undefined;
    readonly setRtcCaptureMode: Dispatch<SetStateAction<RtcSignalingDiagnostics.CaptureMode | undefined>>;
    readonly setResolution: Dispatch<SetStateAction<BoundExecuteResolution | undefined>>;
}

interface ExecuteRunActions {
    readonly operations: ReturnType<typeof useExecuteOperations>;
    readonly policy: ExecuteActionPolicy;
    readonly agentLaunch: ExecuteAgentLaunchModel;
    readonly nextAction: ExecuteNextAction;
    readonly selectionLocked: boolean;
}

interface ExecuteManifestRead {
    readonly draft: ReturnType<typeof useExecuteDraft>;
    readonly recipeSelection: ExecuteRecipeSelection;
    readonly rtcCaptureMode: RtcSignalingDiagnostics.CaptureMode | undefined;
    readonly resolution: BoundExecuteResolution | undefined;
}

interface ExecuteManifestComputed {
    readonly manifest: ExecuteManifestDraft | undefined;
    readonly currentResolution: ExecuteTargetResolutionEvidence | undefined;
    readonly operationContextKey: string;
    readonly unknownDistributedRunId: boolean;
    readonly configurationIssue: string | undefined;
    readonly workflowIssue: string | undefined;
}

export function useExecuteWorkflow(workflowInput: ExecuteWorkflowInput): ExecuteWorkflow {
    const truth = useExecuteRunTruth(workflowInput);
    const catalog = useExecuteCatalog(workflowInput, truth.run);
    useExecuteRecipeLocation(workflowInput, truth.run, catalog.selection);
    const intent = useExecuteManifestIntent(workflowInput, truth, catalog.selection);
    const actions = useExecuteRunActions(workflowInput, truth, intent);
    const { operations } = actions;
    const connection = resolveExecuteConnectionTruth(workflowInput.connection);
    return {
        catalog,
        targetRows: intent.draft.targetRows,
        selectedAgentIds: intent.draft.selectedAgentIds,
        connection,
        manifest: intent.manifest,
        resolution: intent.currentResolution,
        run: truth.run,
        unknownDistributedRunId: intent.unknownDistributedRunId,
        mutationError: operations.mutationError ?? (intent.workflowIssue
            ? projectControlOperationError(new Error(intent.workflowIssue))
            : undefined),
        policy: actions.policy,
        agentLaunch: actions.agentLaunch,
        nextAction: actions.nextAction,
        busyAction: operations.busyAction,
        selectionLocked: actions.selectionLocked,
        rtcCaptureMode: intent.rtcCaptureMode,
        setRtcCaptureMode: intent.setRtcCaptureMode,
        startOpen: operations.startOpen,
        cancelOpen: operations.cancelOpen,
        safeTargetLabel: toExecuteSafeTargetLabel({
            connection,
            rows: intent.draft.targetRows,
            selectedAgentIds: intent.draft.selectedAgentIds
        }),
        setQuery: catalog.setQuery,
        setProfile: catalog.setProfile,
        selectRecipe: (recipeId) => workflowInput.navigate(recipeConsoleExecuteRecipeSelectionPatch(recipeId)),
        toggleTarget: intent.draft.toggleTarget,
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
    };
}

function useExecuteRunTruth(workflowInput: ExecuteWorkflowInput): ExecuteRunTruth {
    const [optimisticRun, setOptimisticRun] = useState<BoundExecuteOptimisticRun>();
    const truthContextKey = toExecuteTruthContextKey({
        baseUrl: workflowInput.connection.baseUrl,
        controlRunId: workflowInput.selection.controlRunId
    });
    const run = reconcileExecuteRunTruth({
        distributedRunId: workflowInput.urlState.distributedRunId,
        optimisticRun: optimisticRun?.contextKey === truthContextKey
            ? optimisticRun.run
            : undefined,
        queriedRun: workflowInput.selection.distributedRun
    });
    useEffect(() => {
        setOptimisticRun((previous) =>
            previous?.contextKey === truthContextKey
                ? previous
                : undefined
        );
    }, [truthContextKey]);
    return { run, truthContextKey, setOptimisticRun };
}

function useExecuteCatalog(
    workflowInput: ExecuteWorkflowInput,
    run: ControlDistributedRunSnapshot | undefined
): ExecuteCatalogState {
    const [query, setQuery] = useState('');
    const [profile, setProfile] = useState('');
    const group = workflowInput.selection.groupContext.group;
    const restoredRecipeId = workflowInput.urlState.recipeId ?? resolveSingleRunRecipeId(run);
    const baseCatalog = useMemo(() =>
        projectDistributedRecipeCatalog({
            configuration: {
                group,
                apiBaseUrl: workflowInput.connection.bootstrap.apiBaseUrl,
                rtcRealtimeDurationSeconds: RALLAR_BLACK_BOX_RTC_REALTIME_DEFAULT_DURATION_SECONDS
            }
        }), [
        group.applicationId,
        group.groupId,
        group.workspaceId,
        workflowInput.connection.bootstrap.apiBaseUrl
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
    return { entries, profiles: catalog.profiles, query, profile, selection: recipeSelection, setQuery, setProfile };
}

function useExecuteRecipeLocation(
    workflowInput: ExecuteWorkflowInput,
    run: ControlDistributedRunSnapshot | undefined,
    recipeSelection: ExecuteRecipeSelection
): void {
    useEffect(() => {
        const awaitingExplicitRun = workflowInput.urlState.distributedRunId && !run &&
            workflowInput.connection.query.snapshot?.distributedRuns === undefined;
        if (awaitingExplicitRun) {
            return;
        }
        const runRecipeId = resolveSingleRunRecipeId(run);
        if (!workflowInput.urlState.recipeId && runRecipeId) {
            workflowInput.replace({ recipeId: runRecipeId });
        }
        else if (recipeSelection.urlReplacePatch) {
            workflowInput.replace(recipeSelection.urlReplacePatch);
        }
    }, [
        workflowInput.connection.query.snapshot?.distributedRuns,
        workflowInput.replace,
        workflowInput.urlState.distributedRunId,
        workflowInput.urlState.recipeId,
        recipeSelection.urlReplacePatch,
        run
    ]);
}

function useExecuteManifestIntent(
    workflowInput: ExecuteWorkflowInput,
    truth: ExecuteRunTruth,
    recipeSelection: ExecuteRecipeSelection
): ExecuteManifestIntent {
    const [rtcCaptureMode, setRtcCaptureMode] = useState<RtcSignalingDiagnostics.CaptureMode | undefined>();
    const [resolution, setResolution] = useState<BoundExecuteResolution>();
    const { run, truthContextKey } = truth;
    const group = workflowInput.selection.groupContext.group;
    const draft = useExecuteDraft({
        connection: workflowInput.connection,
        selection: workflowInput.selection,
        group,
        selectedRecipe: recipeSelection.selected,
        run,
        truthContextKey
    });
    const computed = computeExecuteManifestState(workflowInput, truth, {
        draft,
        recipeSelection,
        rtcCaptureMode,
        resolution
    });
    return { ...computed, draft, recipeSelection, rtcCaptureMode, setRtcCaptureMode, setResolution };
}

function computeExecuteManifestState(
    workflowInput: ExecuteWorkflowInput,
    truth: ExecuteRunTruth,
    read: ExecuteManifestRead
): ExecuteManifestComputed {
    const { run, truthContextKey } = truth;
    const { draft, recipeSelection, rtcCaptureMode, resolution } = read;
    const group = workflowInput.selection.groupContext.group;
    const distributedRunId = workflowInput.urlState.distributedRunId ??
        draft.draftDistributedRunId;
    const selectedAgentIds = draft.selectedAgentIds;
    const generatedManifest = !run && distributedRunId && workflowInput.selection.controlRun &&
            recipeSelection.selected
        ? createExecuteManifestDraft({
            distributedRunId,
            controlRunId: workflowInput.selection.controlRun.runId,
            group,
            selectedRecipe: recipeSelection.selected,
            selectedAgentIds,
            rtcCaptureMode
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
        workflowInput.urlState.distributedRunId &&
            workflowInput.connection.query.snapshot?.distributedRuns &&
            !run
    );
    const configurationIssue = resolveExecuteRunConfigurationIssue({
        run,
        controlRunId: workflowInput.selection.controlRunId,
        recipeId: recipeSelection.selected?.item.recipe.recipeId
    });
    const workflowIssue = configurationIssue ?? requestedManifest?.left ?? draft.draftIssue;
    return {
        manifest,
        currentResolution,
        operationContextKey,
        unknownDistributedRunId,
        configurationIssue,
        workflowIssue
    };
}

function computeExecuteRunPolicyFacts(
    workflowInput: ExecuteWorkflowInput,
    truth: ExecuteRunTruth,
    intent: ExecuteManifestIntent
): ExecuteActionPolicyInput {
    const connection = resolveExecuteConnectionTruth(workflowInput.connection);
    const { run } = truth;
    const { selectedAgentIds, targetRows } = intent.draft;
    const selectedRecipe = intent.recipeSelection.selected;
    return {
        connection,
        runState: run?.state,
        hasKnownRun: run !== undefined,
        unknownDistributedRunId: intent.unknownDistributedRunId,
        recipeAvailable: selectedRecipe !== undefined && !intent.configurationIssue,
        schemaValid: selectedRecipe?.schema.ok === true,
        preflightValid: selectedRecipe?.preflight.errors.length === 0,
        selectedTargetsSafe: selectedAgentIds.length > 0 &&
            selectedAgentIds.every((agentId) => targetRows.some((row) => row.agentId === agentId && row.targetable)),
        manifestValid: intent.manifest?.validationIssues.length === 0,
        resolutionCurrent: intent.currentResolution?.comparison.ok === true,
        busyAction: undefined
    };
}

function useExecuteRunActions(
    workflowInput: ExecuteWorkflowInput,
    truth: ExecuteRunTruth,
    intent: ExecuteManifestIntent
): ExecuteRunActions {
    const { run, truthContextKey, setOptimisticRun } = truth;
    const { manifest, operationContextKey, setResolution } = intent;
    const { selectedAgentIds, targetRows } = intent.draft;
    const connection = resolveExecuteConnectionTruth(workflowInput.connection);
    const policyFacts = computeExecuteRunPolicyFacts(workflowInput, truth, intent);
    const idlePolicy = deriveExecuteActionPolicy({
        ...policyFacts,
        busyAction: undefined
    });
    const operations = useExecuteOperations({
        connection: workflowInput.connection,
        manifest,
        run,
        policy: idlePolicy,
        operationContextKey,
        truthContextKey,
        navigate: workflowInput.navigate,
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
    const agentLaunch = useExecuteWorkflowAgentLaunch(workflowInput, intent, selectionLocked);
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
    return { operations, policy, agentLaunch, nextAction, selectionLocked };
}

function useExecuteWorkflowAgentLaunch(
    workflowInput: ExecuteWorkflowInput,
    intent: ExecuteManifestIntent,
    selectionLocked: boolean
): ExecuteAgentLaunchModel {
    const group = workflowInput.selection.groupContext.group;
    const { targetRows, selectedAgentIds } = intent.draft;
    return useExecuteAgentLaunch({
        connection: workflowInput.connection,
        controlRunId: workflowInput.selection.controlRunId,
        group,
        targetRows,
        selectedAgentIds,
        selectionLocked,
        onBindRunId: (controlRunId) =>
            workflowInput.navigate({
                controlRunId,
                distributedRunId: undefined,
                commandId: undefined
            }),
        onSelectTargets: intent.draft.setSelectedTargets
    });
}
