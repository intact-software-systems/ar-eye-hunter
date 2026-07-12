import type {
    ControlAgentBoardRow,
    ControlAgentBoardSummary,
} from '../../control-agent-board.ts';
import { MetricStrip } from '../ui/MetricStrip.tsx';
import { SelectableRow } from '../ui/SelectableRow.tsx';
import { StatusMark, type OperationalStatus } from '../ui/StatusMark.tsx';
import type { ControlQueryStatus } from './control-query.ts';
import styles from './ControlOverview.module.css';

export function ControlAgentBoard({
    queryStatus,
    rows,
    safeTargetableCount,
    selectedAgentId,
    summary,
    onSelectAgent,
}: Readonly<{
    queryStatus: ControlQueryStatus;
    rows: readonly ControlAgentBoardRow[];
    safeTargetableCount: number;
    selectedAgentId?: string;
    summary: ControlAgentBoardSummary;
    onSelectAgent(agentId: string): void;
}>) {
    const lastKnown = queryStatus === 'stale';
    return (
        <section aria-label="Control agent board" className={styles.board}>
            <div className={styles.boardHeader}>
                <div>
                    <p className={styles.eyebrow}>Repository-derived targeting truth</p>
                    <h3>Control agent board</h3>
                </div>
                <strong>{lastKnown
                    ? `${safeTargetableCount} safe now · ${summary.targetable} last known targetable`
                    : `${safeTargetableCount} safe to target`}</strong>
            </div>
            <MetricStrip
                items={[
                    { label: 'Agents', value: summary.total },
                    { label: lastKnown ? 'Connected (last known)' : 'Connected', value: summary.connected },
                    { label: 'Safe now', value: safeTargetableCount },
                    { label: 'Blocked now', value: summary.total - safeTargetableCount },
                ]}
                label="Control agent summary"
            />
            <div aria-label="Control agents" className={styles.agentGrid} role="listbox">
                {rows.map(row => (
                    <SelectableRow
                        aria-label={agentOptionAccessibleName(row, lastKnown)}
                        data-agent-id={row.agentId}
                        data-control-agent-row
                        data-target-status={row.targetStatus}
                        key={row.agentId}
                        onClick={() => onSelectAgent(row.agentId)}
                        selected={row.agentId === selectedAgentId}
                    >
                        <span className={styles.agentRowHeader}>
                            <code>{row.agentId}</code>
                            <StatusMark
                                label={targetStatusLabel(row, lastKnown)}
                                status={targetStatusTone(row, lastKnown)}
                            />
                        </span>
                        <span className={styles.agentReason}>
                            {lastKnown ? 'Last known: ' : null}{row.targetReason}
                        </span>
                        <span className={styles.agentMeta}>
                            {row.identitySummary ?? 'Identity unavailable'}
                        </span>
                    </SelectableRow>
                ))}
                {rows.length === 0 ? (
                    <p className={styles.emptyBoard}>No agents are available in the selected control context.</p>
                ) : null}
            </div>
        </section>
    );
}

function agentOptionAccessibleName(
    row: ControlAgentBoardRow,
    lastKnown: boolean,
): string {
    return `Select agent ${row.agentId}. ${lastKnown ? 'Last-known evidence. ' : ''}${row.targetReason}`;
}

function targetStatusLabel(row: ControlAgentBoardRow, lastKnown: boolean): string {
    const label = row.targetStatus === 'matched'
        ? 'Matched'
        : row.targetStatus.split('-').map(part =>
            `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`
        ).join(' ');
    return lastKnown ? `${label} · last known` : label;
}

function targetStatusTone(
    row: ControlAgentBoardRow,
    lastKnown: boolean,
): OperationalStatus {
    if (lastKnown || row.targetStatus === 'stale') return 'stale';
    if (row.targetStatus === 'matched') return 'passed';
    if (row.targetStatus === 'offline' || row.targetStatus === 'missing-agent') {
        return 'failed';
    }
    return 'warning';
}
