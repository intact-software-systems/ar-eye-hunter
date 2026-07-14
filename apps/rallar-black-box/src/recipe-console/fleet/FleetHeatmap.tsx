import type { FleetReportHeatmap } from
    '@shared-test/rallar-bb-test/fleet-report-analysis.ts';
import type { ControlFleetRunReport } from
    '@shared-test/rallar-bb-test/fleet-report.ts';
import { ExactIdentifier } from '../ui/ExactIdentifier.tsx';
import styles from './FleetHeatmap.module.css';

export function FleetHeatmap({
    heatmap,
    onSelectAgent,
    onSelectReport,
}: Readonly<{
    heatmap: FleetReportHeatmap;
    onSelectAgent(agentId: string, trigger: HTMLButtonElement): void;
    onSelectReport(report: ControlFleetRunReport, trigger: HTMLButtonElement): void;
}>) {
    return (
        <section aria-labelledby="fleet-heatmap-heading" className={styles.panel}>
            <header className={styles.heading}>
                <div>
                    <span className={styles.eyebrow}>Historical outcomes</span>
                    <h2 id="fleet-heatmap-heading">Agent × run</h2>
                </div>
                <p>{truth(heatmap)}</p>
            </header>
            <div className={styles.scroll} tabIndex={0}>
                <table aria-label="Fleet agent by run heatmap">
                    <thead><tr>
                        <th scope="col">Agent</th>
                        {heatmap.runs.map(run => (
                            <th key={run.distributedRunId} scope="col">
                                <button
                                    data-report-id={run.distributedRunId}
                                    onClick={(event) => onSelectReport(run, event.currentTarget)}
                                    type="button"
                                ><ExactIdentifier value={run.distributedRunId} /></button>
                            </th>
                        ))}
                    </tr></thead>
                    <tbody>{heatmap.rows.map(row => (
                        <tr key={row.agent.agentId}>
                            <th scope="row">
                                <button
                                    data-agent-id={row.agent.agentId}
                                    onClick={(event) => onSelectAgent(
                                        row.agent.agentId,
                                        event.currentTarget,
                                    )}
                                    type="button"
                                >
                                    <ExactIdentifier value={row.agent.agentId} />
                                    <small><bdi dir="auto">{row.region}</bdi> /{' '}
                                        <bdi dir="auto">{row.provider}</bdi></small>
                                </button>
                            </th>
                            {row.cells.map((cell, index) => (
                                <td data-state={cell?.state ?? 'missing-evidence'} key={heatmap.runs[index]?.distributedRunId ?? index}>
                                    <span>{cell ? label(cell.state) : 'No outcome'}</span>
                                </td>
                            ))}
                        </tr>
                    ))}</tbody>
                </table>
            </div>
        </section>
    );
}

function truth(heatmap: FleetReportHeatmap): string {
    return `${heatmap.rows.length.toLocaleString('en-US')} of ${heatmap.totalAgentRows.toLocaleString('en-US')} agents × ${heatmap.runs.length.toLocaleString('en-US')} of ${heatmap.totalRunColumns.toLocaleString('en-US')} runs`;
}

function label(state: string): string {
    return state === 'timed-out' ? 'Timed out' :
        `${state.slice(0, 1).toUpperCase()}${state.slice(1)}`;
}
