import type {
    ControlFleetFailureSignature,
    ControlFleetReportBundle,
    ControlFleetRunReport,
    ControlFleetTimingDistribution
} from '../../../../control-run-manager.ts';
import { formatFleetDuration, formatPercent } from '../../shared/performance-format.ts';
import { shortRunId } from '../../shared/run-id-presentation.ts';
import { fleetAgentStateTone, fleetCellTitle, fleetFailureTone, shortSignatureId } from '../fleet-presentation.ts';
import type { FleetAgentHeatmapRow, FleetTimingGroup } from '../fleet-types.ts';
import { FleetTimingGroupList } from './FleetTimingGroupList.tsx';

export function RunnerFleetReportAnalysis({
    heatmapRows,
    heatmapRuns,
    selectedReport,
    setSelectedReportId,
    setSelectedAgentId,
    setSelectedFailureId,
    regionRows,
    failureRows,
    selectedFailure,
    regionTiming,
    recipeTiming,
    reports,
    busy,
    exportSelectedReport,
    lastExport
}: {
    heatmapRows: readonly FleetAgentHeatmapRow[];
    heatmapRuns: readonly ControlFleetRunReport[];
    selectedReport: ControlFleetRunReport | undefined;
    setSelectedReportId(value: string): void;
    setSelectedAgentId(value: string): void;
    setSelectedFailureId(value: string): void;
    regionRows: readonly Readonly<{
        region: string;
        provider?: string;
        passRate: number;
        timing: ControlFleetTimingDistribution;
        failed: number;
        dominantFailureSignatureId?: string;
    }>[];
    failureRows: readonly ControlFleetFailureSignature[];
    selectedFailure: ControlFleetFailureSignature | undefined;
    regionTiming: readonly FleetTimingGroup[];
    recipeTiming: readonly FleetTimingGroup[];
    reports: readonly ControlFleetRunReport[];
    busy: string | undefined;
    exportSelectedReport(): Promise<void>;
    lastExport: ControlFleetReportBundle | undefined;
}) {
    return (
        <>
            <section className="fleet-subpanel fleet-heatmap-panel">
                <div className="section-heading">
                    <h3>Agent x Run Heatmap</h3>
                    <span>{heatmapRows.length} agents</span>
                </div>
                <div className="fleet-heatmap" role="table">
                    <div className="fleet-heatmap-header" role="row">
                        <span>Agent</span>
                        {heatmapRuns.map((run) => (
                            <button
                                type="button"
                                key={run.distributedRunId}
                                className={run.distributedRunId === selectedReport?.distributedRunId ? 'selected' : ''}
                                title={run.distributedRunId}
                                onClick={() =>
                                    setSelectedReportId(
                                        run.distributedRunId
                                    )}
                            >
                                {shortRunId(run.distributedRunId)}
                            </button>
                        ))}
                    </div>
                    {heatmapRows.map((row) => (
                        <div
                            className="fleet-heatmap-row"
                            role="row"
                            key={row.agent.agentId}
                        >
                            <button
                                type="button"
                                className="fleet-agent-button"
                                onClick={() => setSelectedAgentId(row.agent.agentId)}
                            >
                                <strong>{row.agent.agentId}</strong>
                                <small>
                                    {row.region} / {row.provider}
                                </small>
                            </button>
                            {row.cells.map((cell, index) => (
                                <button
                                    type="button"
                                    key={`${row.agent.agentId}-${heatmapRuns[index]?.distributedRunId ?? index}`}
                                    className={`fleet-cell ${fleetAgentStateTone(cell?.state)}`}
                                    title={fleetCellTitle(cell)}
                                    onClick={() => {
                                        if (cell) {
                                            setSelectedAgentId(
                                                cell.agentId
                                            );
                                            const firstFailure = cell.failureSignatureIds[0];
                                            if (firstFailure) {
                                                setSelectedFailureId(
                                                    firstFailure
                                                );
                                            }
                                        }
                                    }}
                                    aria-label={fleetCellTitle(cell)}
                                />
                            ))}
                        </div>
                    ))}
                </div>
            </section>
            <section className="fleet-subpanel">
                <div className="section-heading">
                    <h3>Region Summary</h3>
                    <span>{regionRows.length}</span>
                </div>
                <div className="fleet-table-scroll">
                    <table className="fleet-table">
                        <thead>
                            <tr>
                                <th>Region</th>
                                <th>Pass</th>
                                <th>P95</th>
                                <th>Failed</th>
                                <th>Dominant failure</th>
                            </tr>
                        </thead>
                        <tbody>
                            {regionRows.map((row) => (
                                <tr key={`${row.region}-${row.provider ?? 'any'}`}>
                                    <td>
                                        <strong>{row.region}</strong>
                                        <small>{row.provider ?? 'any provider'}</small>
                                    </td>
                                    <td>{formatPercent(row.passRate)}</td>
                                    <td>{formatFleetDuration(row.timing.p95Ms)}</td>
                                    <td>{row.failed}</td>
                                    <td>
                                        {shortSignatureId(
                                            row.dominantFailureSignatureId
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>
            <section className="fleet-subpanel">
                <div className="section-heading">
                    <h3>Failure Signatures</h3>
                    <span>{failureRows.length}</span>
                </div>
                <div className="fleet-failure-list">
                    {failureRows.slice(0, 12).map((failure) => (
                        <button
                            type="button"
                            key={failure.signatureId}
                            className={`fleet-failure-row ${
                                failure.signatureId === selectedFailure?.signatureId ? 'selected' : ''
                            }`}
                            onClick={() => setSelectedFailureId(failure.signatureId)}
                        >
                            <span
                                className={`pill ${fleetFailureTone(failure.category)}`}
                            >
                                {failure.category}
                            </span>
                            <strong>{failure.title}</strong>
                            <small>
                                {failure.count} hits - {failure.affectedRegions.join(', ') ||
                                    'unknown region'}
                            </small>
                            <small>{failure.nextAction}</small>
                        </button>
                    ))}
                    {failureRows.length === 0 && (
                        <div className="empty-state">
                            No repeated failure signatures.
                        </div>
                    )}
                </div>
            </section>
            <section className="fleet-subpanel">
                <div className="section-heading">
                    <h3>Timing Distributions</h3>
                    <span>p50 / p95</span>
                </div>
                <div className="fleet-timing-grid">
                    <FleetTimingGroupList
                        title="By region"
                        groups={regionTiming}
                    />
                    <FleetTimingGroupList
                        title="By recipe"
                        groups={recipeTiming}
                    />
                </div>
            </section>
            <section className="fleet-subpanel fleet-report-export">
                <div className="section-heading">
                    <h3>Shareable Run Report</h3>
                    <span>{selectedReport ? selectedReport.state : 'none'}</span>
                </div>
                <div className="fleet-export-row">
                    <label className="field">
                        <span>Run</span>
                        <select
                            value={selectedReport?.distributedRunId ?? ''}
                            onChange={(event) => setSelectedReportId(event.target.value)}
                        >
                            {reports.map((report) => (
                                <option
                                    key={report.distributedRunId}
                                    value={report.distributedRunId}
                                >
                                    {report.distributedRunId}
                                </option>
                            ))}
                        </select>
                    </label>
                    <button
                        type="button"
                        disabled={!selectedReport || Boolean(busy)}
                        onClick={() => void exportSelectedReport()}
                    >
                        Export report
                    </button>
                </div>
                {lastExport && (
                    <div className="fleet-export-files">
                        {Object.keys(lastExport.files).map((name) => (
                            <span className="pill muted" key={name}>
                                {name}
                            </span>
                        ))}
                    </div>
                )}
            </section>
        </>
    );
}
