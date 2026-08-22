import { statusTone } from '../../shared/command-presentation.ts';
import type { CommandQueueRow } from '../runner-contracts.ts';

export function CommandQueuePanel({
    rows,
    selectedCommandId,
    onSelect
}: {
    rows: readonly CommandQueueRow[];
    selectedCommandId?: string;
    onSelect(commandId: string): void;
}) {
    return (
        <section className="panel queue-panel">
            <div className="panel-heading">
                <h2>Command Queue</h2>
                <span>{rows.length} commands</span>
            </div>
            <div className="queue-list">
                {rows.map((row) => (
                    <button
                        type="button"
                        key={row.id}
                        className={`queue-row ${selectedCommandId === row.id ? 'selected' : ''}`}
                        onClick={() => onSelect(row.id)}
                    >
                        <span className={`status-dot ${row.status}`} />
                        <span className="queue-main">
                            <strong>{row.label}</strong>
                            <small>{row.id}</small>
                        </span>
                        <span className={`pill ${statusTone(row.status)}`}>
                            {row.status}
                        </span>
                        <span className="queue-time">
                            {row.timeoutMs ? `${row.timeoutMs} ms` : '-'}
                        </span>
                    </button>
                ))}
            </div>
        </section>
    );
}
