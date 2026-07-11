import {
    useRunnerFleetController,
    type UseRunnerFleetControllerInput,
} from './use-runner-fleet-controller.ts';
import { RunnerFleetControls } from './views/RunnerFleetControls.tsx';
import { RunnerFleetOverview } from './views/RunnerFleetOverview.tsx';
import { RunnerFleetReportAnalysis } from './views/RunnerFleetReportAnalysis.tsx';
import { RunnerFleetSelectedDetails } from './views/RunnerFleetSelectedDetails.tsx';

export function RunnerFleetPanel({
    bootstrap,
    control,
    globalValues,
}: UseRunnerFleetControllerInput) {
    const {
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
        exportSelectedReport,
    } = useRunnerFleetController({ bootstrap, control, globalValues });

    return (
        <section className="panel runner-fleet-panel">
            <div className="panel-heading">
                <h2>Fleet</h2>
                <span>distributed reports</span>
            </div>
            <RunnerFleetControls
                controlBaseUrl={controlBaseUrl}
                setControlBaseUrl={setControlBaseUrl}
                controlToken={controlToken}
                setControlToken={setControlToken}
                filters={filters}
                updateFilter={updateFilter}
                busy={busy}
                refreshFleet={refreshFleet}
                copyShareLink={copyShareLink}
                lastRefresh={lastRefresh}
                reports={reports}
                error={error}
            />
            <RunnerFleetOverview
                liveSnapshot={liveSnapshot}
                liveRunOptions={liveRunOptions}
                liveRun={liveRun}
                liveRunId={liveRunId}
                setLiveRunId={setLiveRunId}
                liveGroupRef={liveGroupRef}
                liveAgentRows={liveAgentRows}
                liveAgentSummary={liveAgentSummary}
                missingLabelAgents={missingLabelAgents}
                overrideText={overrideText}
                setOverrideText={setOverrideText}
                overrides={overrides}
                displaySummary={displaySummary}
                worldMapModel={worldMapModel}
                mapLayers={mapLayers}
                selectedAgentId={selectedAgentId}
                updateMapLayer={updateMapLayer}
                setSelectedAgentId={setSelectedAgentId}
                selectMapRegion={selectMapRegion}
                reports={reports}
                error={error}
            />
            {reports.length > 0 && (
                <div className="fleet-layout">
                    <RunnerFleetReportAnalysis
                        heatmapRows={heatmapRows}
                        heatmapRuns={heatmapRuns}
                        selectedReport={selectedReport}
                        setSelectedReportId={setSelectedReportId}
                        setSelectedAgentId={setSelectedAgentId}
                        setSelectedFailureId={setSelectedFailureId}
                        regionRows={regionRows}
                        failureRows={failureRows}
                        selectedFailure={selectedFailure}
                        regionTiming={regionTiming}
                        recipeTiming={recipeTiming}
                        reports={reports}
                        busy={busy}
                        exportSelectedReport={exportSelectedReport}
                        lastExport={lastExport}
                    />
                    <RunnerFleetSelectedDetails
                        selectedFailure={selectedFailure}
                        selectedAgent={selectedAgent}
                    />
                </div>
            )}
        </section>
    );
}
