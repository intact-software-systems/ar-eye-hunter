import type { RallarBlackBoxBootstrapConfig } from '@shared-test/rallar-bb-test/browser-control-agent-config.ts';
import type { RallarBlackBoxControlSnapshot } from '@shared-test/rallar-bb-test/control-client.ts';
import type { ControlDistributedRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type { RallarBlackBoxDistributedRolePattern } from '@shared-test/rallar-bb-test/distributed-run.ts';
import { Either } from '@shared/resilience/Either.ts';
import { useEffect } from 'react';
import {
    cancelDistributedRun,
    createDistributedRun,
    readDistributedRunArtifactBundle,
    readDistributedTargetResolution,
    stageDistributedRun,
    startDistributedRun
} from '../../../control-run-manager/control-distributed-run-endpoints.ts';
import { createDefaultControlEndpointRequest } from '../../../control-run-manager/control-endpoint-request.ts';
import { toControlFailureMessage } from '../../../control-run-manager/control-request-failure.ts';
import {
    defaultDistributedRecipeTargetIds,
    reconcileDistributedRecipeTargetIds
} from '../../../distributed-recipes.ts';
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
    const controlEndpoint = createDefaultControlEndpointRequest({ baseUrl, token });
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
                const resolutionOutcome = await readDistributedTargetResolution({
                    ...controlEndpoint,
                    manifest
                });
                const resolution = resolutionOutcome.right;
                if (resolution === undefined) {
                    setError(toControlFailureMessage(resolutionOutcome.left));
                    return;
                }
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

    const ensureCreatedDistributedRun = async (): Promise<Either<string, ControlDistributedRunSnapshot>> => {
        if (!manifest) {
            return Either.ofLeft(
                'Build a valid distributed run manifest before creating the run.'
            );
        }
        if (manifestValidation) {
            return Either.ofLeft(manifestValidation);
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
            return Either.ofRight(existing);
        }
        const outcome = await createDistributedRun({
            ...controlEndpoint,
            manifest
        });
        const created = outcome.right;
        if (created === undefined) {
            return Either.ofLeft(toControlFailureMessage(outcome.left));
        }
        setSelectedDistributedRun(created);
        setDistributedRuns((current) => [created, ...current]);
        return Either.ofRight(created);
    };

    const createRun = async (): Promise<void> => {
        setBusyAction('create');
        setError(undefined);
        try {
            const outcome = await ensureCreatedDistributedRun();
            const created = outcome.right;
            if (created === undefined) {
                setError(outcome.left);
                return;
            }
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
                setError(worldFleetBlockReason);
                return;
            }
            const outcome = await ensureCreatedDistributedRun();
            const created = outcome.right;
            if (created === undefined) {
                setError(outcome.left);
                return;
            }
            const stagedOutcome = await stageDistributedRun({
                ...controlEndpoint,
                distributedRunId: created.distributedRunId
            });
            const staged = stagedOutcome.right;
            if (staged === undefined) {
                setError(toControlFailureMessage(stagedOutcome.left));
                return;
            }
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
            const startedOutcome = await startDistributedRun({
                ...controlEndpoint,
                distributedRunId: target.distributedRunId
            });
            const started = startedOutcome.right;
            if (started === undefined) {
                setError(toControlFailureMessage(startedOutcome.left));
                return;
            }
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
            const cancelledOutcome = await cancelDistributedRun({
                ...controlEndpoint,
                distributedRunId: target.distributedRunId,
                reason: 'Cancelled from Rallar Kit Distributed Recipes UI.'
            });
            const cancelled = cancelledOutcome.right;
            if (cancelled === undefined) {
                setError(toControlFailureMessage(cancelledOutcome.left));
                return;
            }
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
            const bundleOutcome = await readDistributedRunArtifactBundle({
                ...controlEndpoint,
                distributedRunId: target.distributedRunId
            });
            const bundle = bundleOutcome.right;
            if (bundle === undefined) {
                setError(toControlFailureMessage(bundleOutcome.left));
                return;
            }
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

    const selectRolePattern = (value: RallarBlackBoxDistributedRolePattern): void => {
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
