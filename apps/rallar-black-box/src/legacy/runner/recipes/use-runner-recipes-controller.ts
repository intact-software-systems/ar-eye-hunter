import { useEffect, useMemo, useState } from 'react';
import type { AuthSession } from '@shared/api/api-config.ts';
import {
    selectRallarBlackBoxCommandHistory,
    selectRallarBlackBoxFailures,
    selectRallarBlackBoxFirstFailure,
} from '@shared-test/rallar-bb-test/selectors.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import {
    deriveControlAgentBoardRows,
    summarizeControlAgentBoardRows,
} from '../../../control-agent-board.ts';
import type { RallarBlackBoxControlSnapshot } from '../../../control-client.ts';
import {
    resolveBlackBoxControlToken,
    type BlackBoxControlTokenSession,
} from '../../../control-operator-token.ts';
import {
    controlHttpBaseUrlFromWsUrl,
    createDistributedRun,
    fetchControlRunSnapshot,
    fetchControlServerSnapshot,
    fetchDistributedRun,
    stageDistributedRun,
    startDistributedRun,
    type ControlDistributedRunArtifactBundle,
    type ControlDistributedRunSnapshot,
    type ControlRunSnapshot,
    type ControlServerSnapshot,
} from '../../../control-run-manager.ts';
import {
    buildDistributedRunManifest,
    defaultDistributedRecipeTargetIds,
    distributedRecipePreflight,
    distributedRecipeTargetRows,
} from '../../../distributed-recipes.ts';
import {
    runnerDisabledReason,
    runnerFriendlyErrorMessage,
    runnerReadinessStatus,
    type RecipeLaunchState,
    type RunnerTurnProbeStatus,
} from '../../../runner-readiness.ts';
import {
    type RallarBlackBoxBootstrapConfig,
    rallarBlackBoxRuntimeStore,
} from '../../../runtime-store.ts';
import { json } from '../../shared/json-presentation.ts';
import { safeIdSegment } from '../../shared/safe-id-segment.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';
import { validateDistributedRecipeManifest } from '../distributed-recipes/distributed-manifest-validation.ts';
import type { RunnerDistributedRunSelection } from '../runner-contracts.ts';
import { RUN_MANAGER_SNAPSHOT_BOUNDS } from '../shared/control-snapshot-bounds.ts';
import { useLatestRequestGuard } from '../shared/use-latest-request-guard.ts';
import { createRunnerAgentLaunchActions } from './runner-agent-launch-actions.ts';
import {
    runnerApiEndpointUrl,
    runnerApiProbeUrl,
} from './runner-endpoints.ts';
import {
    runnerLaunchStateFromRunState,
    type RunnerServiceProbe,
} from './runner-launch-presentation.ts';
import { useRunnerAgentLaunchState } from './use-runner-agent-launch-state.ts';
import { useRunnerRecipeCatalog } from './use-runner-recipe-catalog.ts';

export type UseRunnerRecipesControllerInput = Readonly<{
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    control: RallarBlackBoxControlSnapshot;
    authSession?: AuthSession;
    globalValues: CommandCenterGlobalValues;
    busy: boolean;
    runState: string;
    lastError?: string;
    onDistributedRunStarted(selection: RunnerDistributedRunSelection): void;
}>;

export function useRunnerRecipesController({
    state,
    bootstrap,
    control,
    authSession,
    globalValues,
    busy,
    runState,
    lastError,
    onDistributedRunStarted,
}: UseRunnerRecipesControllerInput) {
    const [controlBaseUrl, setControlBaseUrl] = useState(() =>
        controlHttpBaseUrlFromWsUrl(control.url ?? bootstrap.controlUrl),
    );
    const [controlToken, setControlToken] = useState(
        bootstrap.controlToken ?? '',
    );
    const [brokeredControlToken, setBrokeredControlToken] =
        useState<BlackBoxControlTokenSession | undefined>();
    const [brokeredControlTokenError, setBrokeredControlTokenError] =
        useState<string | undefined>();
    const [controlRunId, setControlRunId] = useState(
        control.runId ?? bootstrap.runId ?? '',
    );
    const {
        agentRunId,
        setAgentRunId,
        agentPrefix,
        setAgentPrefix,
        agentCount,
        setAgentCount,
        agentLaunchSuffix,
        setAgentLaunchSuffix,
        agentRestoreSession,
        setAgentRestoreSession,
        agentLaunchMessage,
        setAgentLaunchMessage,
        agentControlWsUrl,
        agentIds,
        agentLaunchUrls,
    } = useRunnerAgentLaunchState({
        control,
        bootstrap,
        authSession,
        globalValues,
        controlBaseUrl,
        controlToken,
    });
    const [apiProbe, setApiProbe] = useState<RunnerServiceProbe>({
        status: 'checking',
        detail: 'Checking API',
    });
    const [controlProbe, setControlProbe] = useState<RunnerServiceProbe>({
        status: 'checking',
        detail: 'Checking control server',
    });
    const [turnProbe, setTurnProbe] = useState<Readonly<{
        status: RunnerTurnProbeStatus;
        detail?: string;
    }> | undefined>();
    const [controlRun, setControlRun] = useState<ControlRunSnapshot | undefined>();
    const [controlSnapshot, setControlSnapshot] =
        useState<ControlServerSnapshot | undefined>();
    const [distributedRun, setDistributedRun] =
        useState<ControlDistributedRunSnapshot | undefined>();
    const [artifactBundle, setArtifactBundle] =
        useState<ControlDistributedRunArtifactBundle | undefined>();
    const {
        query,
        setQuery,
        profile,
        setProfile,
        sourceFilter,
        setSourceFilter,
        selectedRecipeId,
        setSelectedRecipeId,
        showEditor,
        setShowEditor,
        groupRef,
        catalog,
        profileOptions,
        filteredRecipes,
        selectedRecipe,
        recipePreflight,
    } = useRunnerRecipeCatalog({ globalValues });
    const [busyAction, setBusyAction] = useState<string | undefined>();
    const [launchState, setLaunchState] = useState<RecipeLaunchState>('idle');
    const [launchMessage, setLaunchMessage] = useState(
        'Choose a recipe and run it from this page.',
    );
    const [launchError, setLaunchError] = useState<string | undefined>();
    const readinessRequests = useLatestRequestGuard();
    const targetRows = useMemo(
        () =>
            distributedRecipeTargetRows({
                run: controlRun,
                group: groupRef,
                requiredCommandKinds: recipePreflight?.commandKinds ?? [],
                requiredRecipes: selectedRecipe?.recipe ? [selectedRecipe.recipe] : [],
                nowEpochMs: Date.now(),
            }),
        [controlRun, groupRef, recipePreflight, selectedRecipe?.recipe],
    );
    const recipeAgentRows = useMemo(
        () =>
            deriveControlAgentBoardRows({
                run: controlRun,
                group: groupRef,
                requiredCommandKinds: recipePreflight?.commandKinds ?? [],
                requiredRecipes: selectedRecipe?.recipe ? [selectedRecipe.recipe] : [],
                distributedRuns: [
                    ...(controlSnapshot?.distributedRuns ?? []),
                    ...(distributedRun ? [distributedRun] : []),
                ],
                nowEpochMs: Date.now(),
            }),
        [
            controlRun,
            controlSnapshot?.distributedRuns,
            distributedRun,
            groupRef,
            recipePreflight,
            selectedRecipe?.recipe,
        ],
    );
    const recipeAgentSummary = useMemo(
        () => summarizeControlAgentBoardRows(recipeAgentRows),
        [recipeAgentRows],
    );
    const targetableRows = targetRows.filter((row) => row.targetable);
    const connectedAgentCount =
        controlRun?.agents.filter((agent) => agent.connected).length ?? 0;
    const recipePrerequisiteIssues = selectedRecipe?.recipe
        ? recipePreflight?.errors ?? []
        : ['Recipe JSON is not bundled for browser execution yet. Use Copy command.'];
    const selectedRecipeNeedsLiveRuntime =
        bootstrap.providerMode === 'browser-rallar';
    const readiness = runnerReadinessStatus({
        apiStatus: apiProbe.status,
        apiRequired: selectedRecipeNeedsLiveRuntime,
        authenticated:
            bootstrap.providerMode !== 'browser-rallar' || Boolean(authSession),
        authRequired: selectedRecipeNeedsLiveRuntime,
        groupId: globalValues.roomId,
        controlStatus: controlProbe.status,
        controlRunId,
        connectedAgentCount,
        targetableAgentCount: targetableRows.length,
        turnStatus: turnProbe?.status,
        turnDetail: turnProbe?.detail,
        recipePrerequisiteIssues,
    });
    const localDisabledReason =
        selectedRecipe?.recipe === undefined
            ? recipePrerequisiteIssues[0]
            : runnerDisabledReason(readiness, 'local-browser');
    const distributedDisabledReason =
        selectedRecipe?.distributedItem === undefined
            ? 'This shared-test catalog entry is CLI-only from the SPA. Use Copy command or Advanced artifact import.'
            : runnerDisabledReason(readiness, 'connected-agents');
    const localRunning =
        busy || launchState === 'preparing' || launchState === 'running';
    const history = selectRallarBlackBoxCommandHistory(state);
    const failures = selectRallarBlackBoxFailures(state);
    const firstFailure = selectRallarBlackBoxFirstFailure(state) ?? failures[0];
    const latestResult = history.at(-1);

    useEffect(() => {
        if (!selectedRecipeId && catalog[0]) {
            setSelectedRecipeId(catalog[0].id);
        }
    }, [catalog, selectedRecipeId]);

    useEffect(() => {
        if (!authSession || agentPrefix !== 'agent-agent') {
            return;
        }
        setAgentPrefix(`${safeIdSegment(authSession.username)}-agent`);
    }, [agentPrefix, authSession]);

    useEffect(() => {
        setBrokeredControlToken(undefined);
        setBrokeredControlTokenError(undefined);
    }, [authSession?.clientId, authSession?.sessionId]);

    const resolveDistributedControlToken = async (): Promise<string> => {
        try {
            const resolved = await resolveBlackBoxControlToken({
                manualToken: controlToken,
                brokeredToken: brokeredControlToken,
                apiBaseUrl: globalValues.apiBaseUrl,
                authSession,
            });
            if (resolved.source === 'brokered') {
                setBrokeredControlToken(resolved.session);
            }
            setBrokeredControlTokenError(undefined);
            return resolved.token;
        } catch (error) {
            const message = runnerFriendlyErrorMessage(error);
            setBrokeredControlTokenError(message);
            throw error;
        }
    };

    const refreshReadiness = async (): Promise<void> => {
        const request = readinessRequests.begin();
        setBusyAction('refresh-readiness');
        setApiProbe({ status: 'checking', detail: 'Checking API' });
        setControlProbe({
            status: 'checking',
            detail: 'Checking control server',
        });
        const shouldCheckTurn =
            bootstrap.providerMode === 'browser-rallar' &&
            Boolean(authSession?.accessToken);
        if (shouldCheckTurn) {
            setTurnProbe({ status: 'checking' });
        } else {
            setTurnProbe(undefined);
        }
        setLaunchError(undefined);
        const apiPromise = fetch(
            runnerApiProbeUrl(globalValues.apiBaseUrl),
            {
                method: 'GET',
                headers: authSession?.accessToken
                    ? { Authorization: `Bearer ${authSession.accessToken}` }
                    : undefined,
            },
        )
            .then((response) => {
                if (!request.isCurrent()) return;
                setApiProbe({
                    status: response.status < 500 ? 'online' : 'offline',
                    detail: `HTTP ${response.status}`,
                });
            })
            .catch((error) => {
                if (!request.isCurrent()) return;
                setApiProbe({
                    status: 'offline',
                    detail: runnerFriendlyErrorMessage(error),
                });
            });
        const turnPromise = shouldCheckTurn && authSession
            ? fetch(
                runnerApiEndpointUrl(globalValues.apiBaseUrl, '/api/webrtc/ice'),
                {
                    method: 'GET',
                    headers: {
                        Authorization: `Bearer ${authSession.accessToken}`,
                        'x-client-id': authSession.clientId,
                    },
                },
            )
                .then(async (response) => {
                    if (!request.isCurrent()) return;
                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}`);
                    }
                    const payload = await response.json() as {
                        iceServers?: unknown;
                    };
                    if (!request.isCurrent()) return;
                    const iceServerCount = Array.isArray(payload.iceServers)
                        ? payload.iceServers.length
                        : 0;
                    setTurnProbe({
                        status: iceServerCount > 0 ? 'ready' : 'empty',
                        detail: iceServerCount > 0
                            ? `${iceServerCount} ICE server${iceServerCount === 1 ? '' : 's'} returned`
                            : undefined,
                    });
                })
                .catch((error) => {
                    if (!request.isCurrent()) return;
                    setTurnProbe({
                        status: 'error',
                        detail: runnerFriendlyErrorMessage(error),
                    });
                })
            : Promise.resolve();
        const controlPromise = fetchControlServerSnapshot({
            baseUrl: controlBaseUrl,
            token: controlToken,
            bounds: RUN_MANAGER_SNAPSHOT_BOUNDS,
        })
            .then(async (serverSnapshot) => {
                if (!request.isCurrent()) return;
                setControlSnapshot(serverSnapshot);
                setControlProbe({
                    status: 'online',
                    detail: `${serverSnapshot.runs.length} run(s)`,
                });
                const knownRunIds = new Set(
                    serverSnapshot.runs.map((run) => run.runId),
                );
                const knownPreferredRunId =
                    [
                        controlRunId,
                        agentRunId,
                        control.runId,
                        bootstrap.runId,
                        serverSnapshot.runs[0]?.runId,
                    ].find(
                        (candidate) => candidate && knownRunIds.has(candidate),
                    ) ?? '';
                const nextRunId = knownPreferredRunId || agentRunId;
                setControlRunId(nextRunId);
                if (knownPreferredRunId) {
                    setAgentRunId(knownPreferredRunId);
                    const nextControlRun = await fetchControlRunSnapshot({
                        baseUrl: controlBaseUrl,
                        token: controlToken,
                        runId: knownPreferredRunId,
                        bounds: RUN_MANAGER_SNAPSHOT_BOUNDS,
                    });
                    if (!request.isCurrent()) return;
                    setControlRun(nextControlRun);
                } else {
                    setControlRun(undefined);
                }
            })
            .catch((error) => {
                if (!request.isCurrent()) return;
                setControlSnapshot(undefined);
                setControlRun(undefined);
                setControlProbe({
                    status: 'offline',
                    detail: runnerFriendlyErrorMessage(error),
                });
            });

        await Promise.allSettled([apiPromise, controlPromise, turnPromise]);
        if (request.isCurrent()) setBusyAction(undefined);
    };

    useEffect(() => {
        void refreshReadiness();
        // The initial readiness probe intentionally uses the first rendered form values.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const copyText = async (text: string, message: string): Promise<void> => {
        await navigator.clipboard?.writeText(text);
        setLaunchMessage(message);
    };
    const { copyAgentLinks, openAgentTabs } = createRunnerAgentLaunchActions({
        agentRestoreSession,
        providerMode: bootstrap.providerMode,
        authSession,
        apiBaseUrl: globalValues.apiBaseUrl,
        agentIds,
        agentControlWsUrl,
        agentRunId,
        groupId: globalValues.roomId,
        applicationId: globalValues.applicationId,
        workspaceId: globalValues.workspaceId,
        controlToken,
        copyText,
        setBusyAction,
        setAgentLaunchMessage,
        setAgentLaunchSuffix,
        setControlRunId,
    });

    const runLocalRecipe = async (): Promise<void> => {
        if (!selectedRecipe?.recipe) {
            setLaunchError(recipePrerequisiteIssues[0]);
            return;
        }
        setBusyAction('local-run');
        setLaunchState('preparing');
        setLaunchError(undefined);
        setLaunchMessage(`Loading ${selectedRecipe.title}.`);
        try {
            await rallarBlackBoxRuntimeStore.loadRecipeFromJson(
                json(selectedRecipe.recipe),
                selectedRecipe.id,
            );
            setLaunchState('running');
            setLaunchMessage(`Running ${selectedRecipe.title} in this browser.`);
            await rallarBlackBoxRuntimeStore.runLoadedRecipe();
            const snapshot = rallarBlackBoxRuntimeStore.getSnapshot();
            const nextLaunchState = runnerLaunchStateFromRunState(
                snapshot.runState,
            );
            setLaunchState(nextLaunchState);
            setLaunchMessage(
                snapshot.lastError
                    ? runnerFriendlyErrorMessage(snapshot.lastError)
                    : snapshot.lastAction ??
                          `${selectedRecipe.title} finished.`,
            );
            setLaunchError(
                snapshot.lastError
                    ? runnerFriendlyErrorMessage(snapshot.lastError)
                    : undefined,
            );
        } catch (error) {
            setLaunchState('failed');
            setLaunchError(runnerFriendlyErrorMessage(error));
            setLaunchMessage('Local recipe failed.');
        } finally {
            setBusyAction(undefined);
        }
    };

    const runDistributedRecipe = async (): Promise<void> => {
        if (!selectedRecipe?.distributedItem) {
            setLaunchError(distributedDisabledReason);
            return;
        }
        setBusyAction('distributed-run');
        setLaunchState('preparing');
        setLaunchError(undefined);
        setArtifactBundle(undefined);
        try {
            const [serverSnapshot] = await Promise.all([
                fetchControlServerSnapshot({
                    baseUrl: controlBaseUrl,
                    token: controlToken,
                    bounds: RUN_MANAGER_SNAPSHOT_BOUNDS,
                }),
            ]);
            setControlSnapshot(serverSnapshot);
            const knownRunIds = new Set(
                serverSnapshot.runs.map((run) => run.runId),
            );
            const nextRunId =
                [
                    controlRunId,
                    agentRunId,
                    control.runId,
                    bootstrap.runId,
                    serverSnapshot.runs[0]?.runId,
                ].find(
                    (candidate) => candidate && knownRunIds.has(candidate),
                ) ?? '';
            if (!nextRunId) {
                throw new Error('Control run missing.');
            }
            const latestControlRun = await fetchControlRunSnapshot({
                baseUrl: controlBaseUrl,
                token: controlToken,
                runId: nextRunId,
                bounds: RUN_MANAGER_SNAPSHOT_BOUNDS,
            });
            setControlRunId(nextRunId);
            setControlRun(latestControlRun);
            const preflight = distributedRecipePreflight(
                selectedRecipe.distributedItem.recipe,
            );
            if (preflight.errors.length > 0) {
                throw new Error(preflight.errors[0]);
            }
            const resolvedRows = distributedRecipeTargetRows({
                run: latestControlRun,
                group: groupRef,
                requiredCommandKinds: preflight.commandKinds,
                requiredRecipes: [selectedRecipe.distributedItem.recipe],
            });
            const agentIds = defaultDistributedRecipeTargetIds(resolvedRows);
            if (agentIds.length === 0) {
                throw new Error('No agents connected for this group.');
            }
            const distributedRunId =
                `dist-${safeIdSegment(groupRef.groupId || 'group')}-${Date.now()}`;
            const manifest = buildDistributedRunManifest({
                distributedRunId,
                controlRunId: nextRunId,
                displayName: selectedRecipe.title,
                group: groupRef,
                recipes: [selectedRecipe.distributedItem],
                targetAgentIds: agentIds,
                targetPolicyMode: 'selected-agents',
                rolePattern: 'all-agents',
                ackTimeoutMs: 15_000,
                startMode: 'manual',
                expectedParticipantCount: agentIds.length,
            });
            const manifestError = validateDistributedRecipeManifest(manifest);
            if (manifestError) {
                throw new Error(manifestError);
            }

            const distributedControlToken =
                await resolveDistributedControlToken();
            setLaunchMessage(
                `Creating ${distributedRunId} for ${agentIds.length} agent(s).`,
            );
            const created = await createDistributedRun({
                baseUrl: controlBaseUrl,
                token: distributedControlToken,
                manifest,
            });
            setLaunchMessage(`Staging ${created.distributedRunId}.`);
            const staged = await stageDistributedRun({
                baseUrl: controlBaseUrl,
                token: distributedControlToken,
                distributedRunId: created.distributedRunId,
            });
            setLaunchMessage(`Starting ${staged.distributedRunId}.`);
            const started = await startDistributedRun({
                baseUrl: controlBaseUrl,
                token: distributedControlToken,
                distributedRunId: staged.distributedRunId,
            });
            setDistributedRun(started);
            setLaunchState(
                started.state === 'passed'
                    ? started.rollup.ok
                        ? 'passed'
                        : 'failed'
                    : 'running',
            );
            setLaunchMessage(
                `Started ${started.distributedRunId}. Watch progress in Runs or Event Stream; artifact export is available after agents report.`,
            );
            onDistributedRunStarted({
                distributedRunId: started.distributedRunId,
                controlRunId: nextRunId,
                controlBaseUrl,
                controlToken,
            });
            void fetchDistributedRun({
                baseUrl: controlBaseUrl,
                token: controlToken,
                distributedRunId: started.distributedRunId,
            })
                .then((nextDistributedRun) => {
                    setDistributedRun(nextDistributedRun);
                })
                .catch(() => undefined);
        } catch (error) {
            setLaunchState('failed');
            setLaunchError(runnerFriendlyErrorMessage(error));
            setLaunchMessage('Distributed recipe failed to start.');
        } finally {
            setBusyAction(undefined);
        }
    };

    return {
        selectedRecipe, launchState, busyAction, localDisabledReason,
        localRunning, distributedDisabledReason, runLocalRecipe,
        runDistributedRecipe, readiness, refreshReadiness, openAgentTabs,
        groupRef, recipeAgentRows, recipeAgentSummary, agentRunId,
        agentPrefix, agentCount, agentRestoreSession, agentControlWsUrl,
        controlRun, agentLaunchUrls, agentLaunchMessage, setAgentRunId,
        setControlRunId, setControlRun, setAgentPrefix, setAgentCount,
        setAgentRestoreSession, copyAgentLinks, query, setQuery, profile,
        setProfile, profileOptions, sourceFilter, setSourceFilter,
        controlBaseUrl, setControlBaseUrl, controlToken, setControlToken,
        brokeredControlToken, brokeredControlTokenError, filteredRecipes,
        catalog, apiProbe, controlProbe, targetableRows, connectedAgentCount,
        setSelectedRecipeId, setShowEditor, controlRunId, recipePreflight,
        launchMessage, launchError, history, failures, latestResult,
        firstFailure, distributedRun, artifactBundle, showEditor, copyText,
        runState, lastError,
    };
}

export type RunnerRecipesControllerModel = ReturnType<
    typeof useRunnerRecipesController
>;
