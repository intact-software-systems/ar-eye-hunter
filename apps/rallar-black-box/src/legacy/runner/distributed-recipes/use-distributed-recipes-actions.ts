import { useEffect } from 'react';
import type { RallarBlackBoxControlSnapshot } from '../../../control-client.ts';
import {
    cancelDistributedRun,
    createDistributedRun,
    fetchDistributedRunArtifactBundle,
    resolveDistributedTargets,
    stageDistributedRun,
    startDistributedRun,
    type ControlDistributedRunSnapshot
} from '../../../control-run-manager.ts';
import {
    defaultDistributedRecipeTargetIds,
    reconcileDistributedRecipeTargetIds,
    type DistributedRecipeRolePattern
} from '../../../distributed-recipes.ts';
import type { RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import { json } from '../../shared/json-presentation.ts';
import { safeIdSegment } from '../../shared/safe-id-segment.ts';
import { sameStringArray } from '../../shared/same-string-array.ts';
import type { DistributedRecipeBuilderModel } from './use-distributed-recipe-builder.ts';
import type { DistributedRecipesRemoteStateModel } from './use-distributed-recipes-remote-state.ts';
import { useDistributedRecipesSelectionActions } from './use-distributed-recipes-selection-actions.ts';

type UseDistributedRecipesActionsInput = Readonly<{
    bootstrap: RallarBlackBoxBootstrapConfig;
    control: RallarBlackBoxControlSnapshot;
    roomId: string;
    remote: DistributedRecipesRemoteStateModel;
    builder: DistributedRecipeBuilderModel;
}>;

export function useDistributedRecipesActions({
    bootstrap,
    control,
    roomId,
    remote,
    builder
}: UseDistributedRecipesActionsInput) {
    const {
        baseUrl,
        token,
        selectedRunId,
        distributedRuns,
        setDistributedRuns,
        selectedDistributedRun,
        setSelectedDistributedRun,
        setTargetResolutionPreview,
        artifactBundle,
        setArtifactBundle,
        setBusyAction,
        setError,
        setLastAction
    } = remote;
    const {
        distributedRunId,
        setDistributedRunId,
        expectedParticipantCount,
        groupRef,
        rolePattern,
        setRolePattern,
        targetPolicyMode,
        setTargetPolicyMode,
        targetRows,
        setSelectedAgentIds,
        usesWorldFleetTargets,
        manifest,
        manifestValidation,
        worldFleetBlockReason,
        setSelectedRecipeIds
    } = builder;
    const selectionActions = useDistributedRecipesSelectionActions({
        bootstrap,
        control,
        remote,
        builder
    });
    const refresh = selectionActions.refresh;
    const loadRun = selectionActions.loadRun;
    const loadDistributedRun = selectionActions.loadDistributedRun;

    useEffect(() => {
        void refresh();
        // The initial refresh intentionally uses the first rendered form values.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        setTargetResolutionPreview(undefined);
    }, [
        distributedRunId,
        expectedParticipantCount,
        groupRef.applicationId,
        groupRef.groupId,
        groupRef.workspaceId,
        rolePattern,
        selectedRunId,
        targetPolicyMode
    ]);

    useEffect(() => {
        setSelectedAgentIds((previous) => {
            const next = reconcileDistributedRecipeTargetIds(previous, targetRows);
            return sameStringArray(previous, next) ? previous : next;
        });
    }, [targetRows]);

    const resolveTargets = async (): Promise<void> => {
        setBusyAction('resolve-targets');
        setError(undefined);
        try {
            await loadRun(selectedRunId);
            if (usesWorldFleetTargets && manifest) {
                const resolution = await resolveDistributedTargets({
                    baseUrl,
                    token,
                    manifest
                });
                setTargetResolutionPreview(resolution);
                setSelectedAgentIds(resolution.targetAgentIds);
                setLastAction(
                    `Server resolved ${resolution.summary.selected}/${
                        resolution.summary.expectedParticipantCount ?? expectedParticipantCount
                    } world-fleet target(s).`
                );
                return;
            }
            const defaults = defaultDistributedRecipeTargetIds(targetRows);
            setTargetResolutionPreview(undefined);
            setSelectedAgentIds(defaults);
            setLastAction(`Resolved ${defaults.length} target agent(s).`);
        }
        catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        }
        finally {
            setBusyAction(undefined);
        }
    };

    const ensureCreatedDistributedRun = async (): Promise<ControlDistributedRunSnapshot> => {
        if (!manifest) {
            throw new Error(
                'Build a valid distributed run manifest before creating the run.'
            );
        }
        if (manifestValidation) {
            throw new Error(manifestValidation);
        }
        const existing = selectedDistributedRun?.distributedRunId ===
                manifest.distributedRunId
            ? selectedDistributedRun
            : distributedRuns.find(
                (item) =>
                    item.distributedRunId ===
                        manifest.distributedRunId
            );
        if (existing) {
            return existing;
        }
        const created = await createDistributedRun({
            baseUrl,
            token,
            manifest
        });
        setSelectedDistributedRun(created);
        setDistributedRuns((current) => [created, ...current]);
        return created;
    };

    const createRun = async (): Promise<void> => {
        setBusyAction('create');
        setError(undefined);
        try {
            const created = await ensureCreatedDistributedRun();
            setLastAction(`Created ${created.distributedRunId}.`);
            await refresh(created.controlRunId, created.distributedRunId);
        }
        catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        }
        finally {
            setBusyAction(undefined);
        }
    };

    const stageRun = async (): Promise<void> => {
        setBusyAction('stage');
        setError(undefined);
        try {
            if (worldFleetBlockReason) {
                throw new Error(worldFleetBlockReason);
            }
            const created = await ensureCreatedDistributedRun();
            const staged = await stageDistributedRun({
                baseUrl,
                token,
                distributedRunId: created.distributedRunId
            });
            setSelectedDistributedRun(staged);
            setLastAction(`Staged ${staged.distributedRunId}.`);
            await refresh(staged.controlRunId, staged.distributedRunId);
        }
        catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        }
        finally {
            setBusyAction(undefined);
        }
    };

    const startRun = async (): Promise<void> => {
        if (worldFleetBlockReason) {
            setError(worldFleetBlockReason);
            return;
        }
        const target = selectedDistributedRun ??
            distributedRuns.find(
                (item) => item.distributedRunId === distributedRunId
            );
        if (!target) {
            setError('Create or stage a distributed run before starting it.');
            return;
        }
        setBusyAction('start');
        setError(undefined);
        try {
            const started = await startDistributedRun({
                baseUrl,
                token,
                distributedRunId: target.distributedRunId
            });
            setSelectedDistributedRun(started);
            setLastAction(`Started ${started.distributedRunId}.`);
            await refresh(started.controlRunId, started.distributedRunId);
        }
        catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        }
        finally {
            setBusyAction(undefined);
        }
    };

    const cancelRun = async (): Promise<void> => {
        const target = selectedDistributedRun ??
            distributedRuns.find(
                (item) => item.distributedRunId === distributedRunId
            );
        if (!target) {
            setError('Select a distributed run before cancelling it.');
            return;
        }
        setBusyAction('cancel');
        setError(undefined);
        try {
            const cancelled = await cancelDistributedRun({
                baseUrl,
                token,
                distributedRunId: target.distributedRunId,
                reason: 'Cancelled from Rallar Kit Distributed Recipes UI.'
            });
            setSelectedDistributedRun(cancelled);
            setLastAction(`Cancelled ${cancelled.distributedRunId}.`);
            await refresh(cancelled.controlRunId, cancelled.distributedRunId);
        }
        catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        }
        finally {
            setBusyAction(undefined);
        }
    };

    const loadArtifact = async (): Promise<void> => {
        const target = selectedDistributedRun ??
            distributedRuns.find(
                (item) => item.distributedRunId === distributedRunId
            );
        if (!target) {
            setError('Select a distributed run before exporting artifacts.');
            return;
        }
        setBusyAction('artifact');
        setError(undefined);
        try {
            const bundle = await fetchDistributedRunArtifactBundle({
                baseUrl,
                token,
                distributedRunId: target.distributedRunId
            });
            setArtifactBundle(bundle);
            setLastAction(
                `Loaded distributed artifact for ${target.distributedRunId}.`
            );
        }
        catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        }
        finally {
            setBusyAction(undefined);
        }
    };

    const copyArtifact = async (): Promise<void> => {
        const bundle = artifactBundle;
        if (!bundle) {
            return;
        }
        await navigator.clipboard?.writeText(json(bundle.files));
        setLastAction('Copied distributed artifact files.');
    };

    const toggleRecipe = (itemId: string): void => {
        setSelectedRecipeIds((previous) =>
            previous.includes(itemId)
                ? previous.filter((value) => value !== itemId)
                : [...previous, itemId]
        );
    };

    const toggleAgent = (agentId: string): void => {
        setSelectedAgentIds((previous) =>
            previous.includes(agentId)
                ? previous.filter((value) => value !== agentId)
                : [...previous, agentId]
        );
    };

    const selectRolePattern = (value: DistributedRecipeRolePattern): void => {
        setRolePattern(value);
        if (
            value !== 'all-agents' &&
            targetPolicyMode !== 'all-online-group-members'
        ) {
            setTargetPolicyMode('role-map');
        }
        else if (targetPolicyMode === 'role-map') {
            setTargetPolicyMode('selected-agents');
        }
    };

    const generateNewRunId = (): void => {
        setDistributedRunId(
            `dist-${safeIdSegment(roomId || 'group')}-${Date.now()}`
        );
        setSelectedDistributedRun(undefined);
        setArtifactBundle(undefined);
    };

    const changeDistributedRunId = (value: string): void => {
        setDistributedRunId(value);
        setSelectedDistributedRun(undefined);
        setArtifactBundle(undefined);
    };

    return {
        refresh,
        loadRun,
        resolveTargets,
        createRun,
        stageRun,
        startRun,
        cancelRun,
        loadArtifact,
        copyArtifact,
        loadDistributedRun,
        toggleRecipe,
        toggleAgent,
        selectRolePattern,
        generateNewRunId,
        changeDistributedRunId
    };
}
