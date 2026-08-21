import type { ControlAgentBoardRow, ControlAgentBoardSummary } from '../../../../control-agent-board.ts';
import type {
    ControlFleetRunReport,
    ControlRunSnapshot,
    ControlServerSnapshot
} from '../../../../control-run-manager.ts';
import { FleetWorldMap } from '../../../../fleet-world-map.tsx';
import type {
    FleetWorldMapLayerId,
    FleetWorldMapLayerState,
    FleetWorldMapRegion,
    FleetWorldMapViewModel
} from '../../../../world-map-model.ts';
import { json } from '../../../shared/json-presentation.ts';
import { Metric } from '../../../shared/Metric.tsx';
import { formatTime } from '../../../shared/time-format.ts';
import { ControlAgentBoardPanel } from '../../agents/ControlAgentBoardPanel.tsx';
import { formatFleetDuration, formatPercent } from '../../shared/performance-format.ts';

export function RunnerFleetOverview({
    liveSnapshot,
    liveRunOptions,
    liveRun,
    liveRunId,
    setLiveRunId,
    liveGroupRef,
    liveAgentRows,
    liveAgentSummary,
    missingLabelAgents,
    overrideText,
    setOverrideText,
    overrides,
    displaySummary,
    worldMapModel,
    mapLayers,
    selectedAgentId,
    updateMapLayer,
    setSelectedAgentId,
    selectMapRegion,
    reports,
    error
}: {
    liveSnapshot: ControlServerSnapshot | undefined;
    liveRunOptions: readonly ControlRunSnapshot[];
    liveRun: ControlRunSnapshot | undefined;
    liveRunId: string;
    setLiveRunId(value: string): void;
    liveGroupRef: Readonly<{ applicationId: string; workspaceId: string; groupId: string; }>;
    liveAgentRows: readonly ControlAgentBoardRow[];
    liveAgentSummary: ControlAgentBoardSummary;
    missingLabelAgents: readonly string[];
    overrideText: string;
    setOverrideText(value: string): void;
    overrides: Readonly<{ error?: string; }>;
    displaySummary: Readonly<{
        runs: number;
        agents: number;
        regions: number;
        passRate: number;
        failureGroups: number;
        p95DurationMs?: number;
        stale: number;
    }>;
    worldMapModel: FleetWorldMapViewModel;
    mapLayers: FleetWorldMapLayerState;
    selectedAgentId: string;
    updateMapLayer(layerId: FleetWorldMapLayerId, enabled: boolean): void;
    setSelectedAgentId(value: string): void;
    selectMapRegion(region: FleetWorldMapRegion): void;
    reports: readonly ControlFleetRunReport[];
    error: string | undefined;
}) {
    return (
        <>
            <section className="fleet-live-panel" aria-label="Live Fleet">
                <div className="section-heading">
                    <div>
                        <h3>Live Fleet</h3>
                        <p>
                            Connected control agents for the selected control run, with targetability for the current
                            global group.
                        </p>
                    </div>
                    <span>{liveSnapshot ? `${liveRunOptions.length} run(s)` : 'not loaded'}</span>
                </div>
                <div className="fleet-live-toolbar">
                    <label className="field">
                        <span>Control Run</span>
                        <select
                            value={liveRun?.runId ?? liveRunId}
                            onChange={(event) => setLiveRunId(event.target.value)}
                        >
                            <option value="">Select run</option>
                            {liveRunOptions.map((run) => (
                                <option key={run.runId} value={run.runId}>
                                    {run.runId}
                                </option>
                            ))}
                        </select>
                    </label>
                    <span className="runner-distributed-freshness">
                        {liveRun
                            ? `Updated ${formatTime(liveRun.updatedAtEpochMs)}`
                            : 'Refresh to load control runs'}
                    </span>
                </div>
                <ControlAgentBoardPanel
                    title="Live Fleet Agents"
                    subtitle={liveRun
                        ? `${liveRun.runId} scoped to ${liveGroupRef.groupId || 'missing group'}`
                        : 'No control run selected.'}
                    rows={liveAgentRows}
                    summary={liveAgentSummary}
                    emptyMessage="No live control agents loaded. Refresh the control server or open browser agents."
                />
            </section>
            {missingLabelAgents.length > 0 && (
                <details className="fleet-label-warning">
                    <summary>
                        {missingLabelAgents.length} agents need region/provider labels
                    </summary>
                    <p>
                        Add fleet metadata when agents register, or paste temporary analysis overrides below.
                    </p>
                    <pre className="mini-json">
                        {missingLabelAgents.slice(0, 12).join('\n')}
                    </pre>
                    <textarea
                        rows={5}
                        value={overrideText}
                        onChange={(event) => setOverrideText(event.target.value)}
                        placeholder={json({
                            'agent-01': {
                                region: 'eu-north',
                                provider: 'hetzner'
                            }
                        })}
                    />
                    {overrides.error && (
                        <div className="workbench-error" role="status">
                            {overrides.error}
                        </div>
                    )}
                </details>
            )}
            <div className="fleet-summary-grid">
                <Metric label="Runs" value={String(displaySummary.runs)} />
                <Metric label="Agents" value={String(displaySummary.agents)} />
                <Metric label="Regions" value={String(displaySummary.regions)} />
                <Metric
                    label="Pass rate"
                    value={formatPercent(displaySummary.passRate)}
                    tone={displaySummary.passRate >= 0.95 ? 'good' : 'warn'}
                />
                <Metric
                    label="Failure groups"
                    value={String(displaySummary.failureGroups)}
                    tone={displaySummary.failureGroups > 0 ? 'bad' : 'good'}
                />
                <Metric
                    label="P95 duration"
                    value={formatFleetDuration(displaySummary.p95DurationMs)}
                />
                <Metric
                    label="Stale agents"
                    value={String(displaySummary.stale)}
                    tone={displaySummary.stale > 0 ? 'warn' : 'good'}
                />
            </div>
            <FleetWorldMap
                model={worldMapModel}
                layers={mapLayers}
                selectedAgentId={selectedAgentId}
                onLayerChange={updateMapLayer}
                onSelectAgent={setSelectedAgentId}
                onSelectRegion={selectMapRegion}
            />
            {reports.length === 0 && !error && (
                <div className="empty-state">
                    No terminal distributed run reports found for these filters. Start connected-agent recipes or
                    rebuild the fleet index.
                </div>
            )}
        </>
    );
}
