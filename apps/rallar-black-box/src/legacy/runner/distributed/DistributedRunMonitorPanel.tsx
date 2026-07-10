import { useMemo, useState } from 'react';
import {
    distributedRecipeStateTone,
    type DistributedRunMonitor,
} from '../../../distributed-recipes.ts';
import { FilterSelect } from '../../shared/FilterSelect.tsx';
import { Metric } from '../../shared/Metric.tsx';
import { formatDuration, formatTime } from '../../shared/time-format.ts';
import { uniqueValues } from '../../shared/unique-values.ts';
import {
    type DistributedRuntimeDiagnostic,
    distributedDiagnosticGroupValue,
    distributedDiagnosticSearchText,
} from './distributed-diagnostics.ts';
import {
    distributedCompositeStatusTone,
    distributedDiagnosticTone,
    distributedProgressTone,
} from './status-presentation.ts';

export function DistributedRunMonitorPanel({
    monitor,
}: {
    monitor: DistributedRunMonitor | undefined;
}) {
    const [diagnosticTransportFilter, setDiagnosticTransportFilter] =
        useState('');
    const [diagnosticSeverityFilter, setDiagnosticSeverityFilter] =
        useState('');
    const [diagnosticAgentFilter, setDiagnosticAgentFilter] = useState('');
    const [diagnosticGroupFilter, setDiagnosticGroupFilter] = useState('');
    const [diagnosticQuery, setDiagnosticQuery] = useState('');
    const runtimeDiagnostics: readonly DistributedRuntimeDiagnostic[] =
        monitor?.runtimeDiagnostics ?? [];
    const diagnosticTransports = useMemo(
        () => uniqueValues(runtimeDiagnostics.map((row) => row.transport)),
        [runtimeDiagnostics],
    );
    const diagnosticSeverities = useMemo(
        () => uniqueValues(runtimeDiagnostics.map((row) => row.severity)),
        [runtimeDiagnostics],
    );
    const diagnosticAgents = useMemo(
        () => uniqueValues(runtimeDiagnostics.map((row) => row.agentId)),
        [runtimeDiagnostics],
    );
    const diagnosticGroups = useMemo(
        () =>
            uniqueValues(
                runtimeDiagnostics.map(distributedDiagnosticGroupValue),
            ),
        [runtimeDiagnostics],
    );
    const filteredRuntimeDiagnostics = useMemo(
        () =>
            runtimeDiagnostics.filter((row) => {
                if (
                    diagnosticTransportFilter &&
                    row.transport !== diagnosticTransportFilter
                )
                    return false;
                if (
                    diagnosticSeverityFilter &&
                    row.severity !== diagnosticSeverityFilter
                )
                    return false;
                if (
                    diagnosticAgentFilter &&
                    row.agentId !== diagnosticAgentFilter
                )
                    return false;
                if (
                    diagnosticGroupFilter &&
                    distributedDiagnosticGroupValue(row) !==
                        diagnosticGroupFilter
                )
                    return false;
                const query = diagnosticQuery.trim().toLowerCase();
                return (
                    !query ||
                    distributedDiagnosticSearchText(
                        row,
                        monitor?.distributedRunId,
                    ).includes(query)
                );
            }),
        [
            diagnosticAgentFilter,
            diagnosticGroupFilter,
            diagnosticQuery,
            diagnosticSeverityFilter,
            diagnosticTransportFilter,
            monitor?.distributedRunId,
            runtimeDiagnostics,
        ],
    );

    return (
        <section className="distributed-subpanel distributed-monitor-panel">
            <div className="section-heading">
                <h3>Monitor</h3>
                <span
                    className={`pill ${monitor ? distributedRecipeStateTone(monitor.state) : 'muted'}`}
                >
                    {monitor?.state ?? 'no run'}
                </span>
            </div>
            {!monitor && (
                <div className="empty-state">
                    Select a distributed run to inspect monitor evidence
                </div>
            )}
            {monitor && (
                <>
                    <div className="distributed-monitor-metrics">
                        <Metric
                            label="Commands"
                            value={`${monitor.commandCounts.completed}/${monitor.commandCounts.total}`}
                        />
                        <Metric
                            label="Barrier"
                            value={`${monitor.commandCounts.barrier}`}
                        />
                        <Metric
                            label="Failed commands"
                            value={String(monitor.commandCounts.failed)}
                            tone={
                                monitor.commandCounts.failed > 0
                                    ? 'bad'
                                    : 'good'
                            }
                        />
                        <Metric
                            label="Results"
                            value={`${monitor.resultCounts.ok}/${monitor.resultCounts.total}`}
                        />
                        <Metric
                            label="Composite"
                            value={`${monitor.compositeCounts.failed}/${monitor.compositeCounts.total}`}
                            tone={
                                monitor.compositeCounts.failed > 0
                                    ? 'bad'
                                    : monitor.compositeCounts.total > 0
                                      ? 'good'
                                      : 'muted'
                            }
                        />
                        <Metric
                            label="Diagnostics"
                            value={String(monitor.diagnosticCounts.total)}
                            tone={
                                monitor.diagnosticCounts.error > 0
                                    ? 'bad'
                                    : monitor.diagnosticCounts.warning > 0
                                      ? 'warn'
                                      : monitor.diagnosticCounts.total > 0
                                        ? 'active'
                                        : 'muted'
                            }
                        />
                        <Metric
                            label="WS / RTC"
                            value={`${monitor.diagnosticCounts.ws}/${monitor.diagnosticCounts.rtc}`}
                        />
                        <Metric
                            label="P50 latency"
                            value={formatDuration(monitor.latency.p50Ms)}
                            tone={
                                monitor.latency.p50Ms !== undefined
                                    ? 'active'
                                    : 'muted'
                            }
                        />
                        <Metric
                            label="P95 latency"
                            value={formatDuration(monitor.latency.p95Ms)}
                        />
                        <Metric
                            label="Artifact"
                            value={monitor.artifact.status}
                            tone={
                                monitor.artifact.status === 'valid'
                                    ? 'good'
                                    : monitor.artifact.status === 'not-loaded'
                                      ? 'muted'
                                      : 'bad'
                            }
                        />
                    </div>
                    <div className="distributed-monitor-grid">
                        <section>
                            <h3>Failures First</h3>
                            <div className="distributed-monitor-list">
                                {monitor.failures
                                    .slice(0, 8)
                                    .map((failure, index) => (
                                        <div
                                            className="distributed-monitor-row failure"
                                            key={`${failure.key}-${index}`}
                                        >
                                            <strong>
                                                {failure.code ?? failure.kind}
                                            </strong>
                                            <span>{failure.message}</span>
                                            <small>
                                                {failure.agentId ??
                                                    failure.recipeId ??
                                                    failure.commandId ??
                                                    failure.key}
                                            </small>
                                        </div>
                                    ))}
                                {monitor.failures.length === 0 && (
                                    <div className="empty-state">
                                        No failures
                                    </div>
                                )}
                            </div>
                        </section>
                        <section>
                            <h3>Agent Progress</h3>
                            <div className="distributed-monitor-list">
                                {monitor.agentProgress.map((row) => (
                                    <div
                                        className="distributed-monitor-row"
                                        key={row.agentId}
                                    >
                                        <strong>{row.agentId}</strong>
                                        <span
                                            className={`pill ${distributedProgressTone(row.readiness)}`}
                                        >
                                            ack {row.readiness}
                                        </span>
                                        {row.barrierCommandCount > 0 && (
                                            <span
                                                className={`pill ${distributedProgressTone(row.barrier)}`}
                                            >
                                                barrier {row.barrier}
                                            </span>
                                        )}
                                        <span
                                            className={`pill ${distributedProgressTone(row.execution)}`}
                                        >
                                            run {row.execution}
                                        </span>
                                        <small>
                                            {row.role ?? 'no role'} -{' '}
                                            {row.completedCommandCount} commands
                                            - {row.eventCount} events
                                        </small>
                                    </div>
                                ))}
                                {monitor.agentProgress.length === 0 && (
                                    <div className="empty-state">
                                        No agent progress
                                    </div>
                                )}
                            </div>
                        </section>
                        <section>
                            <h3>Recipe Progress</h3>
                            <div className="distributed-monitor-list">
                                {monitor.recipeProgress.map((row) => (
                                    <div
                                        className="distributed-monitor-row"
                                        key={`${row.recipeId}-${row.role ?? 'all'}`}
                                    >
                                        <strong>{row.recipeId}</strong>
                                        <span className="pill good">
                                            {row.passedCount} passed
                                        </span>
                                        <span
                                            className={`pill ${row.failedCount > 0 ? 'bad' : 'muted'}`}
                                        >
                                            {row.failedCount} failed
                                        </span>
                                        <small>
                                            {row.profile ?? 'default'} -{' '}
                                            {row.queuedCount} queued -{' '}
                                            {row.runningCount} running -{' '}
                                            {row.missingCount} missing
                                        </small>
                                    </div>
                                ))}
                                {monitor.recipeProgress.length === 0 && (
                                    <div className="empty-state">
                                        No recipe progress
                                    </div>
                                )}
                            </div>
                        </section>
                        <section>
                            <h3>ACK Readiness</h3>
                            <div className="distributed-monitor-list">
                                {monitor.readiness.map((row) => (
                                    <div
                                        className="distributed-monitor-row"
                                        key={row.agentId}
                                    >
                                        <strong>{row.agentId}</strong>
                                        <span
                                            className={`pill ${distributedProgressTone(row.status)}`}
                                        >
                                            {row.status}
                                        </span>
                                        <small>
                                            {row.commandId ?? 'no command'} -{' '}
                                            {formatDuration(row.latencyMs)}
                                        </small>
                                        {row.error && (
                                            <small>{row.error}</small>
                                        )}
                                    </div>
                                ))}
                                {monitor.readiness.length === 0 && (
                                    <div className="empty-state">
                                        No ACK rows
                                    </div>
                                )}
                            </div>
                        </section>
                        <section
                            className="distributed-monitor-wide"
                            aria-label="Distributed composite drilldowns"
                        >
                            <h3>Composite Drilldowns</h3>
                            <div className="distributed-composite-list">
                                {monitor.compositeDrilldowns.map(
                                    (drilldown) => (
                                        <details
                                            className={`distributed-composite-card ${drilldown.summary.failed > 0 ? 'failed' : 'passed'}`}
                                            key={drilldown.key}
                                            open={drilldown.summary.failed > 0}
                                        >
                                            <summary>
                                                <strong>
                                                    {drilldown.recipeId ??
                                                        drilldown.commandId}
                                                </strong>
                                                <span
                                                    className={`pill ${drilldown.summary.failed > 0 ? 'bad' : 'good'}`}
                                                >
                                                    {drilldown.summary.failed}{' '}
                                                    failed
                                                </span>
                                                <span className="pill muted">
                                                    {drilldown.summary.total}{' '}
                                                    results
                                                </span>
                                                <small>
                                                    {drilldown.agentId} -{' '}
                                                    {drilldown.role ??
                                                        drilldown.phase ??
                                                        drilldown.commandKind ??
                                                        'command'}{' '}
                                                    - {drilldown.artifactRef}
                                                </small>
                                            </summary>
                                            {drilldown.firstFailure && (
                                                <div className="distributed-composite-focus">
                                                    <strong>
                                                        First failure
                                                    </strong>
                                                    <span className="pill bad">
                                                        {
                                                            drilldown
                                                                .firstFailure
                                                                .kind
                                                        }
                                                    </span>
                                                    <small>
                                                        {
                                                            drilldown
                                                                .firstFailure
                                                                .commandId
                                                        }{' '}
                                                        -{' '}
                                                        {
                                                            drilldown
                                                                .firstFailure
                                                                .path
                                                        }
                                                    </small>
                                                    <small>
                                                        {drilldown.firstFailure
                                                            .errorSummary ??
                                                            drilldown
                                                                .firstFailure
                                                                .summary}
                                                    </small>
                                                </div>
                                            )}
                                            {drilldown.groupSummaries.length >
                                                0 && (
                                                <div className="distributed-composite-groups">
                                                    {drilldown.groupSummaries.map(
                                                        (group) => (
                                                            <div
                                                                className={`distributed-composite-group ${distributedCompositeStatusTone(group.status)}`}
                                                                key={`${group.parentCommandId}-${group.groupId}`}
                                                            >
                                                                <strong>
                                                                    {
                                                                        group.groupId
                                                                    }
                                                                </strong>
                                                                <span
                                                                    className={`pill ${distributedCompositeStatusTone(group.status)}`}
                                                                >
                                                                    {
                                                                        group.status
                                                                    }
                                                                </span>
                                                                <small>
                                                                    {
                                                                        group.passed
                                                                    }{' '}
                                                                    passed -{' '}
                                                                    {
                                                                        group.failed
                                                                    }{' '}
                                                                    failed -{' '}
                                                                    {formatDuration(
                                                                        group.durationMs,
                                                                    )}
                                                                </small>
                                                            </div>
                                                        ),
                                                    )}
                                                </div>
                                            )}
                                            <div className="distributed-composite-rows">
                                                {drilldown.rows.map((row) => (
                                                    <div
                                                        className={`distributed-composite-row ${distributedCompositeStatusTone(row.status)}`}
                                                        key={row.path}
                                                        style={{
                                                            paddingLeft: `${8 + Math.min(row.depth, 6) * 14}px`,
                                                        }}
                                                    >
                                                        <strong>
                                                            {row.originalCommandId ??
                                                                row.commandId}
                                                        </strong>
                                                        <span
                                                            className={`pill ${distributedCompositeStatusTone(row.status)}`}
                                                        >
                                                            {row.status}
                                                        </span>
                                                        <span className="pill muted">
                                                            {row.kind}
                                                        </span>
                                                        <small>
                                                            {row.path} -{' '}
                                                            {
                                                                row.sourceRecipePath
                                                            }{' '}
                                                            -{' '}
                                                            {formatDuration(
                                                                row.durationMs,
                                                            )}
                                                        </small>
                                                        {row.iteration !==
                                                            undefined && (
                                                            <small>
                                                                iteration{' '}
                                                                {row.iteration}
                                                            </small>
                                                        )}
                                                        {row.groupId && (
                                                            <small>
                                                                group{' '}
                                                                {row.groupId}
                                                            </small>
                                                        )}
                                                        <small>
                                                            {row.summary}
                                                        </small>
                                                        {row.detail && (
                                                            <small>
                                                                {row.detail}
                                                            </small>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        </details>
                                    ),
                                )}
                                {monitor.compositeDrilldowns.length === 0 && (
                                    <div className="empty-state">
                                        No composite result drilldowns
                                    </div>
                                )}
                            </div>
                        </section>
                        <section aria-label="Distributed runtime diagnostics">
                            <h3>Runtime Diagnostics</h3>
                            <div className="distributed-diagnostic-filters">
                                <FilterSelect
                                    label="Transport"
                                    value={diagnosticTransportFilter}
                                    values={diagnosticTransports}
                                    onChange={setDiagnosticTransportFilter}
                                />
                                <FilterSelect
                                    label="Severity"
                                    value={diagnosticSeverityFilter}
                                    values={diagnosticSeverities}
                                    onChange={setDiagnosticSeverityFilter}
                                />
                                <FilterSelect
                                    label="Agent"
                                    value={diagnosticAgentFilter}
                                    values={diagnosticAgents}
                                    onChange={setDiagnosticAgentFilter}
                                />
                                <FilterSelect
                                    label="Group"
                                    value={diagnosticGroupFilter}
                                    values={diagnosticGroups}
                                    onChange={setDiagnosticGroupFilter}
                                />
                                <label className="field compact-field">
                                    <span>Search</span>
                                    <input
                                        value={diagnosticQuery}
                                        onChange={(event) =>
                                            setDiagnosticQuery(
                                                event.target.value,
                                            )
                                        }
                                        placeholder="run, command, selector, message"
                                    />
                                </label>
                            </div>
                            <div className="distributed-monitor-list">
                                {filteredRuntimeDiagnostics
                                    .slice(-16)
                                    .reverse()
                                    .map((diagnostic) => (
                                        <div
                                            className={`distributed-monitor-row diagnostic ${distributedDiagnosticTone(diagnostic.severity)}`}
                                            key={diagnostic.eventId}
                                        >
                                            <strong>
                                                {diagnostic.message}
                                            </strong>
                                            <span
                                                className={`pill ${distributedDiagnosticTone(diagnostic.severity)}`}
                                            >
                                                {diagnostic.severity}
                                            </span>
                                            <span className="pill muted">
                                                {diagnostic.transport ??
                                                    'runtime'}
                                            </span>
                                            <small>
                                                {formatTime(
                                                    diagnostic.atEpochMs,
                                                )}{' '}
                                                - {diagnostic.agentId} -{' '}
                                                {diagnostic.commandId ??
                                                    'no command'}
                                            </small>
                                            <small>
                                                {diagnostic.groupId ??
                                                    diagnostic.roomId ??
                                                    diagnostic.contextId ??
                                                    'no group'}{' '}
                                                - {diagnostic.diagnosticTypeId}
                                            </small>
                                            <small>{diagnostic.summary}</small>
                                            {diagnostic.correlatedFailureKeys
                                                .length > 0 && (
                                                <small>
                                                    Related failure:{' '}
                                                    {diagnostic.correlatedFailureKeys.join(
                                                        ', ',
                                                    )}
                                                </small>
                                            )}
                                        </div>
                                    ))}
                                {filteredRuntimeDiagnostics.length === 0 && (
                                    <div className="empty-state">
                                        No matching runtime diagnostics
                                    </div>
                                )}
                            </div>
                        </section>
                        <section>
                            <h3>Run Events</h3>
                            <div className="distributed-monitor-list">
                                {monitor.events.slice(-12).map((event) => (
                                    <div
                                        className="distributed-monitor-row"
                                        key={event.eventId}
                                    >
                                        <strong>{event.kind}</strong>
                                        <span className="pill muted">
                                            {event.agentId}
                                        </span>
                                        <small>
                                            {formatTime(event.atEpochMs)} -{' '}
                                            {event.topic ??
                                                event.commandId ??
                                                'event'}
                                        </small>
                                        <small>{event.summary}</small>
                                        {event.payloadSummary !==
                                            event.summary && (
                                            <small>
                                                {event.payloadSummary}
                                            </small>
                                        )}
                                    </div>
                                ))}
                                {monitor.events.length === 0 && (
                                    <div className="empty-state">
                                        No linked events
                                    </div>
                                )}
                            </div>
                        </section>
                        <section>
                            <h3>Timeline</h3>
                            <div className="distributed-monitor-list">
                                {monitor.timeline.slice(-16).map((item) => (
                                    <div
                                        className="distributed-monitor-row"
                                        key={item.id}
                                    >
                                        <strong>{item.label}</strong>
                                        <span className={`pill ${item.tone}`}>
                                            {item.kind}
                                        </span>
                                        <small>
                                            {formatTime(item.atEpochMs)} -{' '}
                                            {item.agentId ??
                                                item.recipeId ??
                                                item.commandId ??
                                                item.phase ??
                                                '-'}
                                        </small>
                                        {item.detail && (
                                            <small>{item.detail}</small>
                                        )}
                                    </div>
                                ))}
                                {monitor.timeline.length === 0 && (
                                    <div className="empty-state">
                                        No timeline entries
                                    </div>
                                )}
                            </div>
                        </section>
                    </div>
                    <div
                        className={`distributed-artifact-validation ${monitor.artifact.status}`}
                    >
                        <strong>{monitor.artifact.status}</strong>
                        <span>{monitor.artifact.message}</span>
                    </div>
                </>
            )}
        </section>
    );
}
