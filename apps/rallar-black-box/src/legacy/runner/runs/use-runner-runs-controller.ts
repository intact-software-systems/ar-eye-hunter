import { type ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import {
    selectRallarBlackBoxCommandHistory,
    selectRallarBlackBoxFailures,
    selectRallarBlackBoxLatestStats,
} from '@shared-test/rallar-bb-test/selectors.ts';
import { isDistributedRunTerminalState } from '@shared-test/rallar-bb-test/distributed-run.ts';
import {
    analyzeDistributedRunArtifactFiles,
    distributedArtifactBundleFromFiles,
    distributedArtifactSnapshotsFromFiles,
    type DistributedRunAnalysis,
    type DistributedRunArtifactFiles,
} from '@shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import type { RallarBlackBoxControlSnapshot } from '../../../control-client.ts';
import {
    controlHttpBaseUrlFromWsUrl,
    fetchControlRunSnapshot,
    fetchDistributedRun,
    fetchDistributedRunArtifactBundle,
    fetchDistributedRuns,
    type ControlDistributedRunArtifactBundle,
    type ControlDistributedRunSnapshot,
    type ControlRunSnapshot,
} from '../../../control-run-manager.ts';
import {
    deriveControlAgentBoardRows,
    summarizeControlAgentBoardRows,
} from '../../../control-agent-board.ts';
import {
    compareDistributedRuns,
    deriveDistributedRunAnalysisReport,
    deriveDistributedRunMonitor,
    deriveRunVerdictView,
} from '../../../distributed-recipes.ts';
import {
    createSyntheticDistributedRunSeed,
    distributedRunSeedIdFromValue,
    type DistributedRunSeedId,
    type SyntheticDistributedRunSeed,
} from '../../../distributed-run-seeds.ts';
import {
    deriveRtcDiagnostics,
    deriveRtcPerformanceView,
} from '../../../rtc-diagnostics.ts';
import { runnerFriendlyErrorMessage } from '../../../runner-readiness.ts';
import type { RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import { json } from '../../shared/json-presentation.ts';
import type { RunnerDistributedRunSelection } from '../runner-contracts.ts';
import {
    distributedArtifactImportStatus,
    type DistributedArtifactImportStatus,
} from './distributed-artifact-import.ts';
import {
    readDistributedRunSeedFromUrl,
    writeDistributedRunSeedToUrl,
} from './distributed-run-seed-url.ts';
import {
    DISTRIBUTED_ANALYSIS_SNAPSHOT_BOUNDS,
    RUNNER_DISTRIBUTED_POLL_MS,
} from './runner-runs-constants.ts';

export type UseRunnerRunsControllerInput = Readonly<{
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    control: RallarBlackBoxControlSnapshot;
    preferredDistributedRun?: RunnerDistributedRunSelection;
}>;

export function useRunnerRunsController({
    state,
    bootstrap,
    control,
    preferredDistributedRun,
}: UseRunnerRunsControllerInput) {
    const history = selectRallarBlackBoxCommandHistory(state);
    const failures = selectRallarBlackBoxFailures(state);
    const latestStats = selectRallarBlackBoxLatestStats(state);
    const recentHistory = [...history].reverse().slice(0, 12);
    const initialSyntheticSeed = useMemo<SyntheticDistributedRunSeed | undefined>(
        () => {
            const distributedRunSeed = readDistributedRunSeedFromUrl();
            return distributedRunSeed
                ? createSyntheticDistributedRunSeed(distributedRunSeed)
                : undefined;
        },
        [],
    );
    const [controlBaseUrl, setControlBaseUrl] = useState(() =>
        preferredDistributedRun?.controlBaseUrl ??
            controlHttpBaseUrlFromWsUrl(control.url ?? bootstrap.controlUrl)
    );
    const [controlToken, setControlToken] = useState(
        preferredDistributedRun?.controlToken ?? bootstrap.controlToken ?? '',
    );
    const [controlRunId, setControlRunId] = useState(
        initialSyntheticSeed?.controlRun.runId ??
            preferredDistributedRun?.controlRunId ?? control.runId ??
            bootstrap.runId ?? '',
    );
    const [distributedRuns, setDistributedRuns] = useState<
        readonly ControlDistributedRunSnapshot[]
    >(() => initialSyntheticSeed ? [initialSyntheticSeed.distributedRun] : []);
    const [selectedDistributedRunId, setSelectedDistributedRunId] = useState(
        initialSyntheticSeed?.distributedRun.distributedRunId ??
            preferredDistributedRun?.distributedRunId ?? '',
    );
    const [selectedDistributedRun, setSelectedDistributedRun] = useState<
        ControlDistributedRunSnapshot | undefined
    >(initialSyntheticSeed?.distributedRun);
    const [distributedControlRun, setDistributedControlRun] = useState<
        ControlRunSnapshot | undefined
    >(initialSyntheticSeed?.controlRun);
    const [artifactBundle, setArtifactBundle] = useState<
        ControlDistributedRunArtifactBundle | undefined
    >(initialSyntheticSeed?.artifactBundle);
    const [importedArtifactAnalysis, setImportedArtifactAnalysis] = useState<
        DistributedRunAnalysis | undefined
    >();
    const [importedArtifactStatus, setImportedArtifactStatus] = useState<
        DistributedArtifactImportStatus | undefined
    >();
    const [selectedSyntheticSeedId, setSelectedSyntheticSeedId] = useState<
        DistributedRunSeedId | ''
    >(initialSyntheticSeed?.id ?? '');
    const [activeSyntheticSeed, setActiveSyntheticSeed] = useState<
        SyntheticDistributedRunSeed | undefined
    >(initialSyntheticSeed);
    const [distributedBusy, setDistributedBusy] = useState<string | undefined>();
    const [distributedError, setDistributedError] = useState<string | undefined>();
    const [lastDistributedRefresh, setLastDistributedRefresh] =
        useState<number | undefined>(initialSyntheticSeed?.generatedAtEpochMs);
    const [compareLeftId, setCompareLeftId] = useState(
        initialSyntheticSeed?.distributedRun.distributedRunId ?? '',
    );
    const [compareRightId, setCompareRightId] = useState('');
    const didInitialDistributedRefresh = useRef(false);
    const activeSyntheticSeedRef = useRef<SyntheticDistributedRunSeed | undefined>(
        initialSyntheticSeed,
    );
    const selectedMonitor = useMemo(
        () =>
            selectedDistributedRun
                ? deriveDistributedRunMonitor({
                    distributedRun: selectedDistributedRun,
                    controlRun: distributedControlRun,
                    artifactBundle,
                })
                : undefined,
        [artifactBundle, distributedControlRun, selectedDistributedRun],
    );
    const runParticipantRows = useMemo(
        () =>
            selectedDistributedRun
                ? deriveControlAgentBoardRows({
                    run: distributedControlRun,
                    group: selectedDistributedRun.manifest.group,
                    agentIds: selectedDistributedRun.targetAgentIds,
                    distributedRuns,
                    selectedDistributedRun,
                    monitorAgentProgress: selectedMonitor?.agentProgress ?? [],
                    nowEpochMs: Date.now(),
                })
                : [],
        [
            distributedControlRun,
            distributedRuns,
            selectedDistributedRun,
            selectedMonitor?.agentProgress,
        ],
    );
    const runParticipantSummary = useMemo(
        () => summarizeControlAgentBoardRows(runParticipantRows),
        [runParticipantRows],
    );
    const analysisReport = useMemo(
        () =>
            selectedDistributedRun
                ? deriveDistributedRunAnalysisReport({
                    distributedRun: selectedDistributedRun,
                    controlRun: distributedControlRun,
                    artifactBundle,
                    snapshotBounds: DISTRIBUTED_ANALYSIS_SNAPSHOT_BOUNDS,
                })
                : undefined,
        [artifactBundle, distributedControlRun, selectedDistributedRun],
    );
    const runVerdict = useMemo(
        () =>
            deriveRunVerdictView({
                distributedRun: selectedDistributedRun,
                monitor: selectedMonitor,
                report: analysisReport,
                artifactBundle,
                refreshedAtEpochMs: lastDistributedRefresh,
            }),
        [
            analysisReport,
            artifactBundle,
            lastDistributedRefresh,
            selectedDistributedRun,
            selectedMonitor,
        ],
    );
    const rtcDiagnostics = useMemo(() => deriveRtcDiagnostics(state), [state]);
    const rtcPerformance = useMemo(
        () =>
            deriveRtcPerformanceView({
                diagnostics: rtcDiagnostics,
                state,
                distributedMonitor: selectedMonitor,
            }),
        [rtcDiagnostics, selectedMonitor, state],
    );
    const compareLeftRun = useMemo(
        () =>
            distributedRuns.find(
                (item) => item.distributedRunId === compareLeftId,
            ),
        [compareLeftId, distributedRuns],
    );
    const compareRightRun = useMemo(
        () =>
            distributedRuns.find(
                (item) => item.distributedRunId === compareRightId,
            ),
        [compareRightId, distributedRuns],
    );
    const compareSummary = useMemo(
        () =>
            compareLeftRun && compareRightRun
                ? compareDistributedRuns({
                    left: compareLeftRun,
                    right: compareRightRun,
                    leftControlRun:
                        compareLeftRun.controlRunId === distributedControlRun?.runId
                            ? distributedControlRun
                            : undefined,
                    rightControlRun:
                        compareRightRun.controlRunId === distributedControlRun?.runId
                            ? distributedControlRun
                            : undefined,
                })
                : undefined,
        [compareLeftRun, compareRightRun, distributedControlRun],
    );

    const refreshDistributedAnalysis = async (
        override?: RunnerDistributedRunSelection,
        options: Readonly<{ loadArtifact?: boolean; quiet?: boolean }> = {},
    ): Promise<void> => {
        if (activeSyntheticSeedRef.current && !override) {
            return;
        }
        const baseUrl = override?.controlBaseUrl ?? controlBaseUrl;
        const token = override?.controlToken ?? controlToken;
        const preferredRunId =
            override?.distributedRunId ?? selectedDistributedRunId;
        if (!options.quiet) {
            setDistributedBusy(options.loadArtifact ? 'artifact' : 'refresh');
        }
        setDistributedError(undefined);
        try {
            const fetchedRuns = await fetchDistributedRuns({ baseUrl, token });
            const list = [...fetchedRuns].sort(
                (left, right) => right.updatedAtEpochMs - left.updatedAtEpochMs,
            );
            const selectedFromList = preferredRunId
                ? list.find((item) => item.distributedRunId === preferredRunId)
                : undefined;
            const nextDistributedRun = preferredRunId
                ? await fetchDistributedRun({
                    baseUrl,
                    token,
                    distributedRunId: preferredRunId,
                }).catch(() => selectedFromList)
                : list[0];
            const nextControlRunId =
                nextDistributedRun?.controlRunId ?? override?.controlRunId ??
                    controlRunId;
            const nextControlRun = nextControlRunId
                ? await fetchControlRunSnapshot({
                    baseUrl,
                    token,
                    runId: nextControlRunId,
                    bounds: DISTRIBUTED_ANALYSIS_SNAPSHOT_BOUNDS,
                }).catch(() => undefined)
                : undefined;
            const shouldLoadArtifact = Boolean(
                nextDistributedRun &&
                    (options.loadArtifact ||
                        isDistributedRunTerminalState(nextDistributedRun.state)),
            );
            const nextArtifact = shouldLoadArtifact && nextDistributedRun
                ? await fetchDistributedRunArtifactBundle({
                    baseUrl,
                    token,
                    distributedRunId: nextDistributedRun.distributedRunId,
                }).catch(() => undefined)
                : preferredRunId === selectedDistributedRunId
                ? artifactBundle
                : undefined;

            if (activeSyntheticSeedRef.current && !override) {
                return;
            }
            setControlBaseUrl(baseUrl);
            setControlToken(token ?? '');
            setDistributedRuns(list);
            setSelectedDistributedRun(nextDistributedRun);
            setSelectedDistributedRunId(nextDistributedRun?.distributedRunId ?? '');
            setControlRunId(nextControlRunId ?? '');
            setDistributedControlRun(nextControlRun);
            setArtifactBundle(nextArtifact);
            setImportedArtifactAnalysis(undefined);
            setImportedArtifactStatus(undefined);
            setLastDistributedRefresh(Date.now());
            setCompareLeftId((current) =>
                current || nextDistributedRun?.distributedRunId || '',
            );
            setCompareRightId((current) => {
                if (current) {
                    return current;
                }
                const otherRun = list.find(
                    (item) =>
                        item.distributedRunId !==
                            nextDistributedRun?.distributedRunId,
                );
                return otherRun?.distributedRunId ?? '';
            });
        } catch (error) {
            setDistributedError(runnerFriendlyErrorMessage(error));
        } finally {
            if (!options.quiet) {
                setDistributedBusy(undefined);
            }
        }
    };

    const applySyntheticDistributedRunSeed = (
        seedId: DistributedRunSeedId,
    ): void => {
        const seed = createSyntheticDistributedRunSeed(seedId);
        activeSyntheticSeedRef.current = seed;
        setActiveSyntheticSeed(seed);
        setSelectedSyntheticSeedId(seed.id);
        setDistributedBusy(undefined);
        setDistributedError(undefined);
        setImportedArtifactAnalysis(undefined);
        setImportedArtifactStatus(undefined);
        setDistributedRuns([seed.distributedRun]);
        setSelectedDistributedRun(seed.distributedRun);
        setSelectedDistributedRunId(seed.distributedRun.distributedRunId);
        setControlRunId(seed.controlRun.runId);
        setDistributedControlRun(seed.controlRun);
        setArtifactBundle(seed.artifactBundle);
        setLastDistributedRefresh(seed.generatedAtEpochMs);
        setCompareLeftId(seed.distributedRun.distributedRunId);
        setCompareRightId('');
        writeDistributedRunSeedToUrl(seed.id);
    };

    const clearSyntheticDistributedRunSeed = (): void => {
        activeSyntheticSeedRef.current = undefined;
        setActiveSyntheticSeed(undefined);
        setSelectedSyntheticSeedId('');
        setDistributedRuns([]);
        setSelectedDistributedRun(undefined);
        setSelectedDistributedRunId('');
        setDistributedControlRun(undefined);
        setArtifactBundle(undefined);
        setLastDistributedRefresh(undefined);
        setCompareLeftId('');
        setCompareRightId('');
        setDistributedError(undefined);
        setImportedArtifactAnalysis(undefined);
        setImportedArtifactStatus(undefined);
        writeDistributedRunSeedToUrl(undefined);
    };

    const selectSyntheticDistributedRunSeed = (value: string): void => {
        const seedId = distributedRunSeedIdFromValue(value);
        if (seedId) {
            applySyntheticDistributedRunSeed(seedId);
            return;
        }
        clearSyntheticDistributedRunSeed();
    };

    const loadDistributedArtifact = async (): Promise<void> => {
        if (activeSyntheticSeed) {
            setArtifactBundle(activeSyntheticSeed.artifactBundle);
            return;
        }
        await refreshDistributedAnalysis(undefined, {
            loadArtifact: true,
        });
    };

    const handleDistributedArtifactFiles = async (
        event: ChangeEvent<HTMLInputElement>,
    ): Promise<void> => {
        const selectedFiles = Array.from(event.currentTarget.files ?? []);
        if (selectedFiles.length === 0) {
            return;
        }
        setDistributedBusy('artifact import');
        setDistributedError(undefined);
        try {
            const files: Record<string, string> = {};
            await Promise.all(selectedFiles.map(async (file) => {
                files[file.name] = await file.text();
            }));
            const generatedAtEpochMs = Date.now();
            const artifactFiles: DistributedRunArtifactFiles = files;
            const analysis = analyzeDistributedRunArtifactFiles({
                files: artifactFiles,
                generatedAtEpochMs,
            });
            const snapshots = distributedArtifactSnapshotsFromFiles(
                artifactFiles,
                generatedAtEpochMs,
            );
            const bundle = distributedArtifactBundleFromFiles(
                artifactFiles,
                generatedAtEpochMs,
                analysis.distributedRunId,
            );
            activeSyntheticSeedRef.current = undefined;
            setActiveSyntheticSeed(undefined);
            setSelectedSyntheticSeedId('');
            setImportedArtifactAnalysis(analysis);
            setImportedArtifactStatus(distributedArtifactImportStatus(
                artifactFiles,
                analysis.parseWarnings.length,
            ));
            setDistributedRuns((current) => [
                snapshots.distributedRun,
                ...current.filter((item) =>
                    item.distributedRunId !== snapshots.distributedRun.distributedRunId
                ),
            ]);
            setSelectedDistributedRun(snapshots.distributedRun);
            setSelectedDistributedRunId(snapshots.distributedRun.distributedRunId);
            setControlRunId(snapshots.controlRun.runId);
            setDistributedControlRun(snapshots.controlRun);
            setArtifactBundle(bundle ?? snapshots.artifactBundle);
            setLastDistributedRefresh(generatedAtEpochMs);
            setCompareLeftId(snapshots.distributedRun.distributedRunId);
            setCompareRightId('');
            writeDistributedRunSeedToUrl(undefined);
        } catch (error) {
            setDistributedError(runnerFriendlyErrorMessage(error));
        } finally {
            setDistributedBusy(undefined);
            event.currentTarget.value = '';
        }
    };

    useEffect(() => {
        if (!preferredDistributedRun) {
            return;
        }
        activeSyntheticSeedRef.current = undefined;
        setActiveSyntheticSeed(undefined);
        setSelectedSyntheticSeedId('');
        writeDistributedRunSeedToUrl(undefined);
        setArtifactBundle(undefined);
        setControlBaseUrl(preferredDistributedRun.controlBaseUrl);
        setControlToken(preferredDistributedRun.controlToken ?? '');
        setControlRunId(preferredDistributedRun.controlRunId);
        setSelectedDistributedRunId(preferredDistributedRun.distributedRunId);
        void refreshDistributedAnalysis(preferredDistributedRun);
        // The preferred run object is the handoff from Recipes into Runs.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        preferredDistributedRun?.controlBaseUrl,
        preferredDistributedRun?.controlRunId,
        preferredDistributedRun?.controlToken,
        preferredDistributedRun?.distributedRunId,
    ]);

    useEffect(() => {
        if (
            didInitialDistributedRefresh.current ||
            preferredDistributedRun ||
            activeSyntheticSeedRef.current
        ) {
            return;
        }
        didInitialDistributedRefresh.current = true;
        void refreshDistributedAnalysis(undefined, { quiet: true });
        // Initial distributed analysis uses first rendered control values.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (
            activeSyntheticSeed ||
            !selectedDistributedRun ||
            isDistributedRunTerminalState(selectedDistributedRun.state)
        ) {
            return;
        }
        const timer = window.setInterval(() => {
            void refreshDistributedAnalysis(undefined, { quiet: true });
        }, RUNNER_DISTRIBUTED_POLL_MS);
        return () => window.clearInterval(timer);
        // Poll the selected run while it is non-terminal.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        controlBaseUrl,
        controlToken,
        selectedDistributedRun?.distributedRunId,
        selectedDistributedRun?.state,
    ]);

    useEffect(() => {
        if (
            activeSyntheticSeed ||
            !selectedDistributedRun ||
            !isDistributedRunTerminalState(selectedDistributedRun.state) ||
            artifactBundle
        ) {
            return;
        }
        void refreshDistributedAnalysis(undefined, {
            loadArtifact: true,
            quiet: true,
        });
        // Terminal runs should pull artifacts automatically.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        artifactBundle,
        selectedDistributedRun?.distributedRunId,
        selectedDistributedRun?.state,
    ]);

    const selectDistributedRun = (distributedRunId: string): void => {
        setSelectedDistributedRunId(distributedRunId);
        setArtifactBundle(undefined);
        setImportedArtifactAnalysis(undefined);
        setImportedArtifactStatus(undefined);
        const selected = distributedRuns.find(
            (item) => item.distributedRunId === distributedRunId,
        );
        void refreshDistributedAnalysis({
            distributedRunId,
            controlRunId: selected?.controlRunId ?? controlRunId,
            controlBaseUrl,
            controlToken,
        });
    };

    const copyDistributedArtifact = async (): Promise<void> => {
        if (!artifactBundle) {
            return;
        }
        await navigator.clipboard?.writeText(json(artifactBundle.files));
    };

    return {
        runLabel: control.runId ?? bootstrap.runId ?? 'local',
        runVerdict,
        rtcPerformance,
        selectedDistributedRun,
        distributedBusy,
        activeSyntheticSeed,
        selectedSyntheticSeedId,
        selectSyntheticDistributedRunSeed,
        controlBaseUrl,
        setControlBaseUrl,
        controlToken,
        setControlToken,
        selectedDistributedRunId,
        selectDistributedRun,
        distributedRuns,
        refreshDistributedAnalysis,
        artifactBundle,
        loadDistributedArtifact,
        copyDistributedArtifact,
        handleDistributedArtifactFiles,
        clearSyntheticDistributedRunSeed,
        lastDistributedRefresh,
        controlRunId,
        distributedError,
        runParticipantRows,
        runParticipantSummary,
        analysisReport,
        importedArtifactAnalysis,
        importedArtifactStatus,
        selectedMonitor,
        compareLeftId,
        compareRightId,
        compareSummary,
        setCompareLeftId,
        setCompareRightId,
        history,
        failures,
        latestStats,
        recentHistory,
    };
}

export type RunnerRunsControllerModel = ReturnType<
    typeof useRunnerRunsController
>;
