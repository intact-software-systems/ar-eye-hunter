import type {
    ControlAgentBoardRow,
    ControlAgentRunParticipation,
} from '../../../control-agent-board.ts';
import { distributedRecipeStateTone } from '../../../distributed-recipes.ts';
import { formatDuration, formatTime } from '../../shared/time-format.ts';
import { distributedProgressTone } from '../distributed/status-presentation.ts';
import { shortRunId } from '../shared/run-id-presentation.ts';
import {
    controlAgentConnectionTone,
    controlAgentTargetTone,
    controlAgentVisibleParticipations,
} from './control-agent-board-presentation.ts';

export function ControlAgentBoardRowView({
    row,
    selected,
    selectionDisabled,
    onToggleAgent,
}: {
    row: ControlAgentBoardRow;
    selected: boolean;
    selectionDisabled: boolean;
    onToggleAgent?(agentId: string): void;
}) {
    const identity =
        row.identitySummary ??
        row.principalId ??
        row.username ??
        row.sessionId ??
        'no identity';
    const scope =
        `${row.applicationId ?? '-'}/${row.workspaceId ?? '-'} group ${row.groupId ?? '-'}`;
    const browser = [
        row.browserLabel ?? row.browserName,
        row.browserVersion,
        row.os,
    ].filter(Boolean).join(' ');
    const location = [
        row.region,
        row.provider,
        row.datacenter,
        row.hostId,
    ].filter(Boolean).join(' / ');
    const visibleRuns = controlAgentVisibleParticipations(row);

    return (
        <article
            className={`control-agent-board-row ${onToggleAgent ? 'selectable' : ''} ${selected ? 'selected' : ''} ${row.synthetic ? 'synthetic' : ''}`}
        >
            {onToggleAgent && (
                <input
                    type="checkbox"
                    checked={selected}
                    disabled={selectionDisabled}
                    onChange={() => onToggleAgent(row.agentId)}
                    aria-label={`Select control agent ${row.agentId}`}
                />
            )}
            <div className="control-agent-board-main">
                <div className="control-agent-board-title">
                    <strong>{row.agentId}</strong>
                    <span
                        className={`pill ${controlAgentConnectionTone(row)}`}
                    >
                        {row.synthetic
                            ? 'missing'
                            : row.connected
                              ? 'connected'
                              : 'offline'}
                    </span>
                    <span
                        className={`pill ${controlAgentTargetTone(row)}`}
                    >
                        {row.targetStatus}
                    </span>
                </div>
                <small>{identity}</small>
                <small>{scope}</small>
                {(browser || location) && (
                    <small>
                        {[browser, location].filter(Boolean).join(' - ')}
                    </small>
                )}
                {row.crdtSupported !== undefined && (
                    <small>
                        CRDT {row.crdtSupported ? 'available' : 'unavailable'}
                        {row.crdtTransports.length > 0
                            ? ` - ${row.crdtTransports.join(', ')}`
                            : ''}
                    </small>
                )}
                <small>{row.targetReason}</small>
            </div>
            <div className="control-agent-board-counters">
                <span>
                    heartbeat{' '}
                    {row.heartbeatAgeMs !== undefined
                        ? formatDuration(row.heartbeatAgeMs)
                        : formatTime(row.lastHeartbeatAtEpochMs)}
                </span>
                <span>{row.reconnectCount} reconnects</span>
                <span>{row.queuedCommandCount} queued</span>
                <span>{row.completedCommandCount} done</span>
                <span>{row.receivedResultCount} results</span>
                <span>{row.receivedEventCount} events</span>
            </div>
            <div className="control-agent-board-runs">
                {visibleRuns.map((participation) => (
                    <ControlAgentRunParticipationChip
                        key={`${row.agentId}-${participation.distributedRunId}-${participation.selected ? 'selected' : 'active'}`}
                        participation={participation}
                    />
                ))}
                {visibleRuns.length === 0 && (
                    <span className="pill muted">no active run</span>
                )}
            </div>
        </article>
    );
}

function ControlAgentRunParticipationChip({
    participation,
}: {
    participation: ControlAgentRunParticipation;
}) {
    return (
        <div className="control-agent-run-chip">
            <span
                className={`pill ${distributedRecipeStateTone(participation.state)}`}
            >
                {participation.selected ? 'selected' : 'active'}{' '}
                {participation.state}
            </span>
            <strong>{shortRunId(participation.distributedRunId)}</strong>
            <small>
                {[
                    participation.role,
                    participation.commandPhases.join('+') || undefined,
                    `${participation.commandCount} commands`,
                ].filter(Boolean).join(' - ')}
            </small>
            {(participation.readiness ||
                participation.barrier ||
                participation.execution) && (
                <div className="control-agent-run-progress">
                    {participation.readiness && (
                        <span
                            className={`pill ${distributedProgressTone(participation.readiness)}`}
                        >
                            ack {participation.readiness}
                        </span>
                    )}
                    {participation.barrier && (
                        <span
                            className={`pill ${distributedProgressTone(participation.barrier)}`}
                        >
                            barrier {participation.barrier}
                        </span>
                    )}
                    {participation.execution && (
                        <span
                            className={`pill ${distributedProgressTone(participation.execution)}`}
                        >
                            run {participation.execution}
                        </span>
                    )}
                </div>
            )}
            <small>
                {participation.completedCommandCount ?? 0} completed -{' '}
                {participation.eventCount ?? 0} events
                {participation.blockingFailures > 0
                    ? ` - ${participation.blockingFailures} blocking`
                    : ''}
            </small>
        </div>
    );
}
