import type { ControlRunAgentRow } from '../../../control-run-manager.ts';
import { formatTime } from '../../shared/time-format.ts';

export function RunManagerAgentRow({
    row,
    selected,
    onToggle
}: {
    row: ControlRunAgentRow;
    selected: boolean;
    onToggle(agentId: string): void;
}) {
    return (
        <label
            className={`run-manager-agent-row ${selected ? 'selected' : ''}`}
        >
            <input
                type="checkbox"
                checked={selected}
                onChange={() => onToggle(row.agentId)}
                aria-label={`Select agent ${row.agentId}`}
            />
            <span>
                <strong>{row.agentId}</strong>
                <small>
                    {row.status} - heartbeat {formatTime(row.lastHeartbeatAtEpochMs)}
                </small>
                {row.identitySummary && <small>{row.identitySummary}</small>}
            </span>
            <span className={`pill ${row.connected ? 'active' : 'muted'}`}>
                {row.connected ? 'connected' : 'offline'}
            </span>
            <span className="run-manager-agent-counts">
                {row.queuedCommandCount} queued / {row.completedCommandCount} done
            </span>
        </label>
    );
}
