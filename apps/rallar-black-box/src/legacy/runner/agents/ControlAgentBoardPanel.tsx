import type {
    ControlAgentBoardRow,
    ControlAgentBoardSummary,
} from '../../../control-agent-board.ts';
import { Metric } from '../../shared/Metric.tsx';
import { ControlAgentBoardRowView } from './ControlAgentBoardRowView.tsx';

export function ControlAgentBoardPanel({
    title,
    subtitle,
    rows,
    summary,
    emptyMessage,
    selectedAgentIds,
    onToggleAgent,
    disableUntargetableSelection = false,
    compact = false,
}: {
    title: string;
    subtitle?: string;
    rows: readonly ControlAgentBoardRow[];
    summary: ControlAgentBoardSummary;
    emptyMessage: string;
    selectedAgentIds?: ReadonlySet<string>;
    onToggleAgent?(agentId: string): void;
    disableUntargetableSelection?: boolean;
    compact?: boolean;
}) {
    return (
        <section
            className={`control-agent-board-panel ${compact ? 'compact' : ''}`}
            aria-label={title}
        >
            <div className="section-heading">
                <div>
                    <h3>{title}</h3>
                    {subtitle && <p>{subtitle}</p>}
                </div>
                <span
                    className={`pill ${summary.targetable > 0 ? 'good' : summary.connected > 0 ? 'warn' : 'muted'}`}
                >
                    {summary.targetable}/{summary.connected} targetable
                </span>
            </div>
            <div className="control-agent-board-summary">
                <Metric label="Agents" value={String(summary.total)} />
                <Metric
                    label="Connected"
                    value={String(summary.connected)}
                    tone={summary.connected > 0 ? 'good' : 'muted'}
                />
                <Metric
                    label="Targetable"
                    value={String(summary.targetable)}
                    tone={summary.targetable > 0 ? 'good' : 'bad'}
                />
                <Metric
                    label="Active runs"
                    value={String(summary.active)}
                    tone={summary.active > 0 ? 'active' : 'muted'}
                />
                <Metric
                    label="Blocked"
                    value={String(
                        summary.stale +
                            summary.offline +
                            summary.wrongGroup +
                            summary.missingIdentity +
                            summary.missingCapability,
                    )}
                    tone={
                        summary.stale +
                                summary.offline +
                                summary.wrongGroup +
                                summary.missingIdentity +
                                summary.missingCapability >
                            0
                            ? 'warn'
                            : 'good'
                    }
                />
            </div>
            <div className="control-agent-board-list">
                {rows.map((row) => {
                    const selected = selectedAgentIds?.has(row.agentId) ?? false;
                    const selectionDisabled =
                        disableUntargetableSelection && !row.targetable;
                    return (
                        <ControlAgentBoardRowView
                            key={row.agentId}
                            row={row}
                            selected={selected}
                            selectionDisabled={selectionDisabled}
                            onToggleAgent={onToggleAgent}
                        />
                    );
                })}
                {rows.length === 0 && (
                    <div className="empty-state">{emptyMessage}</div>
                )}
            </div>
        </section>
    );
}
