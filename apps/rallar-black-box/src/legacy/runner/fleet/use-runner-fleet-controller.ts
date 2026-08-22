import { useEffect, useMemo, useState } from 'react';
import { deriveControlAgentBoardRows, summarizeControlAgentBoardRows } from '../../../control-agent-board.ts';
import type { RallarBlackBoxControlSnapshot } from '../../../control-client.ts';
import {
    controlHttpBaseUrlFromWsUrl,
    fetchControlServerSnapshot,
    fetchFleetReportBundle,
    fetchFleetReports,
    rebuildFleetReports,
    type ControlFleetReportBundle,
    type ControlFleetReportsResponse,
    type ControlServerSnapshot
} from '../../../control-run-manager.ts';
import { runnerFriendlyErrorMessage } from '../../../runner-readiness.ts';
import type { RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import {
    deriveFleetWorldMapModel,
    routeEvidenceFromControlRun,
    type FleetWorldMapLayerId,
    type FleetWorldMapLayerState,
    type FleetWorldMapRegion
} from '../../../world-map-model.ts';
import { json } from '../../shared/json-presentation.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';
import { RUN_MANAGER_SNAPSHOT_BOUNDS } from '../shared/control-snapshot-bounds.ts';
import { useLatestRequestGuard } from '../shared/use-latest-request-guard.ts';
import { fleetAgentDetail, fleetHeatmapRows, fleetMissingLabelAgents, fleetRegionRows } from './fleet-derivations.ts';
import {
    applyFleetLabelOverrides,
    buildFleetShareUrl,
    fleetReportFilterFromUi,
    parseFleetLabelOverrides,
    readFleetFiltersFromUrl,
    readFleetWorldMapLayersFromUrl,
    writeFleetFiltersToUrl,
    writeFleetWorldMapLayersToUrl
} from './fleet-helpers.ts';
import { fleetDisplaySummary, fleetFailureRows } from './fleet-rollups.ts';
import { fleetTimingGroupsByRecipe, fleetTimingGroupsByRegion } from './fleet-timing.ts';
import type { FleetFilterState } from './fleet-types.ts';

export type UseRunnerFleetControllerInput = Readonly<{
    bootstrap: RallarBlackBoxBootstrapConfig;
    control: RallarBlackBoxControlSnapshot;
    globalValues: CommandCenterGlobalValues;
}>;

export function useRunnerFleetController({
    bootstrap,
    control,
    globalValues
}: UseRunnerFleetControllerInput) {
    const [controlBaseUrl, setControlBaseUrl] = useState(() =>
        controlHttpBaseUrlFromWsUrl(control.url ?? bootstrap.controlUrl)
    );
    const [controlToken, setControlToken] = useState(
        bootstrap.controlToken ?? ''
    );
    const [filters, setFilters] = useState<FleetFilterState>(
        readFleetFiltersFromUrl
    );
    const [mapLayers, setMapLayers] = useState<FleetWorldMapLayerState>(
        readFleetWorldMapLayersFromUrl
    );
    const [response, setResponse] = useState<ControlFleetReportsResponse | undefined>();
    const [liveSnapshot, setLiveSnapshot] = useState<ControlServerSnapshot | undefined>();
    const [liveRunId, setLiveRunId] = useState(
        control.runId ?? bootstrap.runId ?? ''
    );
    const [busy, setBusy] = useState<string | undefined>();
    const [error, setError] = useState<string | undefined>();
    const [lastRefresh, setLastRefresh] = useState<number | undefined>();
    const [selectedAgentId, setSelectedAgentId] = useState('');
    const [selectedFailureId, setSelectedFailureId] = useState('');
    const [selectedReportId, setSelectedReportId] = useState('');
    const [overrideText, setOverrideText] = useState('');
    const [lastExport, setLastExport] = useState<ControlFleetReportBundle | undefined>();
    const fleetRefreshRequests = useLatestRequestGuard();
    const overrides = useMemo(
        () => parseFleetLabelOverrides(overrideText),
        [overrideText]
    );
    const reports = useMemo(
        () =>
            applyFleetLabelOverrides(
                response?.reports ?? [],
                overrides.value
            ),
        [overrides.value, response?.reports]
    );
    const displaySummary = useMemo(
        () => fleetDisplaySummary(reports, response),
        [reports, response]
    );
    const heatmapRuns = useMemo(() => reports.slice(0, 12), [reports]);
    const heatmapRows = useMemo(
        () => fleetHeatmapRows(reports, heatmapRuns),
        [heatmapRuns, reports]
    );
    const regionRows = useMemo(() => fleetRegionRows(reports), [reports]);
    const failureRows = useMemo(
        () => fleetFailureRows(reports),
        [reports]
    );
    const selectedFailure = failureRows.find(
        (failure) => failure.signatureId === selectedFailureId
    ) ?? failureRows[0];
    const selectedAgent = selectedAgentId
        ? fleetAgentDetail(selectedAgentId, reports)
        : undefined;
    const regionTiming = useMemo(
        () => fleetTimingGroupsByRegion(reports).slice(0, 8),
        [reports]
    );
    const recipeTiming = useMemo(
        () => fleetTimingGroupsByRecipe(reports).slice(0, 8),
        [reports]
    );
    const missingLabelAgents = useMemo(
        () => fleetMissingLabelAgents(reports),
        [reports]
    );
    const selectedReport = reports.find(
        (report) => report.distributedRunId === selectedReportId
    ) ?? reports[0];
    const liveGroupRef = useMemo(
        () => ({
            applicationId: globalValues.applicationId,
            workspaceId: globalValues.workspaceId,
            groupId: globalValues.roomId
        }),
        [
            globalValues.applicationId,
            globalValues.roomId,
            globalValues.workspaceId
        ]
    );
    const liveRunOptions = useMemo(
        () =>
            [...(liveSnapshot?.runs ?? [])].sort(
                (left, right) => right.updatedAtEpochMs - left.updatedAtEpochMs
            ),
        [liveSnapshot]
    );
    const liveRun = useMemo(
        () =>
            liveRunOptions.find((run) => run.runId === liveRunId) ??
                liveRunOptions[0],
        [liveRunId, liveRunOptions]
    );
    const liveAgentRows = useMemo(
        () =>
            deriveControlAgentBoardRows({
                run: liveRun,
                group: liveGroupRef,
                distributedRuns: liveSnapshot?.distributedRuns ?? [],
                nowEpochMs: Date.now()
            }),
        [liveGroupRef, liveRun, liveSnapshot?.distributedRuns]
    );
    const liveAgentSummary = useMemo(
        () => summarizeControlAgentBoardRows(liveAgentRows),
        [liveAgentRows]
    );
    const routeEvidence = useMemo(
        () => routeEvidenceFromControlRun(liveRun),
        [liveRun]
    );
    const worldMapModel = useMemo(
        () =>
            deriveFleetWorldMapModel({
                liveAgents: liveAgentRows,
                reports,
                routeEvidence
            }),
        [liveAgentRows, reports, routeEvidence]
    );

    const refreshFleet = async (
        options: Readonly<{ rebuild?: boolean; quiet?: boolean; }> = {}
    ): Promise<void> => {
        const request = fleetRefreshRequests.begin();
        if (!options.quiet) {
            setBusy(options.rebuild ? 'rebuild' : 'refresh');
        }
        setError(undefined);
        try {
            const nextResponse = options.rebuild
                ? await rebuildFleetReports({
                    baseUrl: controlBaseUrl,
                    token: controlToken
                })
                : await fetchFleetReports({
                    baseUrl: controlBaseUrl,
                    token: controlToken,
                    filter: fleetReportFilterFromUi(filters)
                });
            if (!request.isCurrent()) {
                return;
            }
            const nextSnapshot = await fetchControlServerSnapshot({
                baseUrl: controlBaseUrl,
                token: controlToken,
                bounds: RUN_MANAGER_SNAPSHOT_BOUNDS
            });
            if (!request.isCurrent()) {
                return;
            }
            setResponse(nextResponse);
            setLiveSnapshot(nextSnapshot);
            setLiveRunId((current) => {
                const knownRunIds = new Set(
                    nextSnapshot.runs.map((run) => run.runId)
                );
                return current && knownRunIds.has(current)
                    ? current
                    : [
                        control.runId,
                        bootstrap.runId,
                        nextSnapshot.runs[0]?.runId
                    ].find((runId) => runId && knownRunIds.has(runId)) ?? '';
            });
            setLastRefresh(Date.now());
            setSelectedReportId((current) =>
                current ||
                nextResponse.reports[0]?.distributedRunId ||
                ''
            );
        }
        catch (caught) {
            if (request.isCurrent()) {
                setError(runnerFriendlyErrorMessage(caught));
            }
        }
        finally {
            if (request.isCurrent() && !options.quiet) {
                setBusy(undefined);
            }
        }
    };

    useEffect(() => {
        void refreshFleet({ quiet: true });
        // Initial fleet refresh uses first rendered control values.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        writeFleetFiltersToUrl(filters);
    }, [filters]);

    useEffect(() => {
        writeFleetWorldMapLayersToUrl(mapLayers);
    }, [mapLayers]);

    useEffect(() => {
        if (!selectedReportId && reports[0]) {
            setSelectedReportId(reports[0].distributedRunId);
        }
    }, [reports, selectedReportId]);

    const updateFilter = <K extends keyof FleetFilterState>(
        key: K,
        value: FleetFilterState[K]
    ): void => {
        setFilters((current) => ({ ...current, [key]: value }));
    };

    const updateMapLayer = (
        layerId: FleetWorldMapLayerId,
        enabled: boolean
    ): void => {
        setMapLayers((current) => ({
            ...current,
            [layerId]: enabled
        }));
    };

    const selectMapRegion = (region: FleetWorldMapRegion): void => {
        if (region.region && region.region !== 'unlabeled') {
            updateFilter('region', region.region);
        }
        if (region.provider) {
            updateFilter('provider', region.provider);
        }
        if (region.latestRunId) {
            setSelectedReportId(region.latestRunId);
        }
    };

    const copyShareLink = async (): Promise<void> => {
        if (typeof window === 'undefined') {
            return;
        }
        await navigator.clipboard?.writeText(
            buildFleetShareUrl(window.location.href, filters, mapLayers)
        );
    };

    const exportSelectedReport = async (): Promise<void> => {
        if (!selectedReport) {
            return;
        }
        setBusy('export');
        setError(undefined);
        try {
            const bundle = await fetchFleetReportBundle({
                baseUrl: controlBaseUrl,
                token: controlToken,
                distributedRunId: selectedReport.distributedRunId
            });
            setLastExport(bundle);
            await navigator.clipboard?.writeText(json(bundle.files));
        }
        catch (caught) {
            setError(runnerFriendlyErrorMessage(caught));
        }
        finally {
            setBusy(undefined);
        }
    };

    return {
        controlBaseUrl,
        setControlBaseUrl,
        controlToken,
        setControlToken,
        filters,
        mapLayers,
        liveSnapshot,
        liveRunId,
        setLiveRunId,
        busy,
        error,
        lastRefresh,
        selectedAgentId,
        setSelectedAgentId,
        setSelectedFailureId,
        setSelectedReportId,
        overrideText,
        setOverrideText,
        lastExport,
        overrides,
        reports,
        displaySummary,
        heatmapRuns,
        heatmapRows,
        regionRows,
        failureRows,
        selectedFailure,
        selectedAgent,
        regionTiming,
        recipeTiming,
        missingLabelAgents,
        selectedReport,
        liveGroupRef,
        liveRunOptions,
        liveRun,
        liveAgentRows,
        liveAgentSummary,
        worldMapModel,
        refreshFleet,
        updateFilter,
        updateMapLayer,
        selectMapRegion,
        copyShareLink,
        exportSelectedReport
    };
}

export type RunnerFleetControllerModel = ReturnType<typeof useRunnerFleetController>;
