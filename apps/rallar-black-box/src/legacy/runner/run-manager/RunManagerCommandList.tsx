import type { ControlRunCommandRow } from '../../../control-run-manager.ts';
import { statusTone } from '../../shared/command-presentation.ts';
import { formatTime } from '../../shared/time-format.ts';

export function RunManagerCommandList({
    rows,
}: {
    rows: readonly ControlRunCommandRow[];
}) {
    return (
        <div className="run-manager-command-list">
            {rows.map((row) => (
                <div
                    key={`${row.agentId}-${row.commandId}`}
                    className="run-manager-command-row"
                >
                    <span>
                        <strong>{row.commandId}</strong>
                        <small>
                            {row.agentId} - {row.kind}
                        </small>
                    </span>
                    <span className={`pill ${statusTone(row.status)}`}>
                        {row.status}
                    </span>
                    <span>{row.dispatchCount} dispatches</span>
                    <span>
                        {formatTime(
                            row.completedAtEpochMs ?? row.queuedAtEpochMs,
                        )}
                    </span>
                </div>
            ))}
            {rows.length === 0 && (
                <div className="empty-state">No commands</div>
            )}
        </div>
    );
}
