import type { ControlAgentBoardRow } from '../../control-agent-board.ts';
import { ExactIdentifier } from '../ui/ExactIdentifier.tsx';
import styles from './FleetEvidence.module.css';

export function FleetLiveBoard({
    onSelectAgent,
    rows,
    selectedAgentId,
}: Readonly<{
    onSelectAgent(agentId: string, trigger: HTMLButtonElement): void;
    rows: readonly ControlAgentBoardRow[];
    selectedAgentId?: string;
}>) {
    return (
        <section aria-labelledby="fleet-live-heading" className={styles.panel}>
            <header className={styles.heading}>
                <div>
                    <span className={styles.eyebrow}>Current root snapshot</span>
                    <h2 id="fleet-live-heading">Live agent board</h2>
                </div>
                <p>{rows.length.toLocaleString('en-US')} mounted agents</p>
            </header>
            {rows.length === 0 ? <p className={styles.empty}>No live agent evidence.</p> : (
                <div className={styles.tableScroll} tabIndex={0}>
                    <table>
                        <thead><tr>
                            <th scope="col">Agent</th>
                            <th scope="col">Connection</th>
                            <th scope="col">Region / provider</th>
                            <th scope="col">Target</th>
                            <th scope="col">Activity</th>
                        </tr></thead>
                        <tbody>{rows.map(row => (
                            <tr key={row.agentId}>
                                <th scope="row">
                                    <button
                                        aria-pressed={row.agentId === selectedAgentId}
                                        className={styles.identityButton}
                                        data-agent-id={row.agentId}
                                        onClick={(event) => onSelectAgent(
                                            row.agentId,
                                            event.currentTarget,
                                        )}
                                        type="button"
                                    ><ExactIdentifier value={row.agentId} /></button>
                                </th>
                                <td><Status value={row.connected ? 'Connected' : row.connectionStatus} ok={row.connected} /></td>
                                <td><bdi dir="auto">{row.region ?? 'Unresolved'}</bdi> /{' '}
                                    <bdi dir="auto">{row.provider ?? 'Unknown'}</bdi></td>
                                <td><bdi dir="auto">{row.targetReason}</bdi></td>
                                <td>{row.activeRuns.length.toLocaleString('en-US')} active runs</td>
                            </tr>
                        ))}</tbody>
                    </table>
                </div>
            )}
        </section>
    );
}

function Status({ value, ok }: Readonly<{ value: string; ok: boolean }>) {
    return <span className={styles.status} data-tone={ok ? 'passed' : 'failed'}>{value}</span>;
}
