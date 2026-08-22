import { distributedRecipeStateTone, type DistributedRunAnalysisReport } from '../../../distributed-recipes.ts';
import { json } from '../../shared/json-presentation.ts';
import { Metric } from '../../shared/Metric.tsx';
import { formatDuration, formatTime } from '../../shared/time-format.ts';
import {
    distributedDiagnosticTone,
    distributedFailureCategoryTone,
    distributedProgressTone
} from '../distributed/status-presentation.ts';

export function DistributedRunAnalysisReportPanel({
    report
}: {
    report: DistributedRunAnalysisReport;
}) {
    const firstFailure = report.firstFailure;
    const topAgents = report.agents.slice(0, 8);
    const topRecipes = report.recipes.slice(0, 8);
    const diagnostics = report.diagnostics.correlated.slice(0, 6);
    const stateTone = report.summary.ok
        ? 'good'
        : firstFailure
        ? 'bad'
        : distributedRecipeStateTone(report.summary.state);

    return (
        <section className="distributed-subpanel runner-analysis-report">
            <div className="section-heading">
                <h3>Analysis Report</h3>
                <span className={`pill ${stateTone}`}>
                    {report.summary.ok ? 'passed' : report.summary.state}
                </span>
            </div>
            <div className="distributed-monitor-metrics">
                <Metric
                    label="Verdict"
                    value={report.summary.ok ? 'passed' : 'attention'}
                    tone={stateTone}
                />
                <Metric
                    label="Duration"
                    value={formatDuration(report.summary.durationMs)}
                />
                <Metric
                    label="Targets"
                    value={String(report.summary.targetCount)}
                />
                <Metric
                    label="Commands"
                    value={`${report.summary.completedCommandCount}/${report.summary.commandCount}`}
                />
                <Metric
                    label="Failed"
                    value={String(report.summary.failedCommandCount)}
                    tone={report.summary.failedCommandCount > 0 ? 'bad' : 'good'}
                />
                <Metric
                    label="Artifact"
                    value={report.summary.artifactStatus}
                    tone={report.summary.artifactStatus === 'valid'
                        ? 'good'
                        : report.summary.artifactStatus === 'not-loaded'
                        ? 'muted'
                        : 'bad'}
                />
            </div>
            {report.summary.snapshotWarnings.length > 0 && (
                <div className="runner-analysis-warning" role="status">
                    <strong>Snapshot may be truncated</strong>
                    <span>{report.summary.snapshotWarnings.join(' ')}</span>
                </div>
            )}
            {firstFailure
                ? (
                    <section className="runner-analysis-first-failure">
                        <div>
                            <span className="eyebrow">First failure</span>
                            <h4>{firstFailure.code ?? firstFailure.category}</h4>
                            <p>{firstFailure.message}</p>
                        </div>
                        <dl>
                            <div>
                                <dt>Agent</dt>
                                <dd>{firstFailure.agentId ?? '-'}</dd>
                            </div>
                            <div>
                                <dt>Recipe</dt>
                                <dd>{firstFailure.recipeId ?? '-'}</dd>
                            </div>
                            <div>
                                <dt>Command</dt>
                                <dd>{firstFailure.commandId ?? '-'}</dd>
                            </div>
                            <div>
                                <dt>Time</dt>
                                <dd>{formatTime(firstFailure.atEpochMs)}</dd>
                            </div>
                        </dl>
                    </section>
                )
                : (
                    <div className="empty-state">
                        No failure evidence in the selected distributed run.
                    </div>
                )}
            <section className="runner-analysis-actions">
                <div className="section-heading compact">
                    <h3>Next Actions</h3>
                    <span>{report.nextActions.length}</span>
                </div>
                <div className="runner-analysis-action-list">
                    {report.nextActions.slice(0, 6).map((action, index) => (
                        <article
                            className="runner-analysis-action-row"
                            key={`${action.category}-${action.title}-${index}`}
                        >
                            <span
                                className={`pill ${distributedFailureCategoryTone(action.category)}`}
                            >
                                {action.category}
                            </span>
                            <div>
                                <strong>{action.title}</strong>
                                <small>{action.likelyCause}</small>
                                <small>{action.nextAction}</small>
                                {action.evidence.length > 0 && (
                                    <small>
                                        Evidence: {action.evidence.join(', ')}
                                    </small>
                                )}
                            </div>
                        </article>
                    ))}
                    {report.nextActions.length === 0 && (
                        <div className="empty-state">
                            No recommended action for this run.
                        </div>
                    )}
                </div>
            </section>
            <div className="runner-analysis-grid">
                <section>
                    <h3>Agents</h3>
                    <div className="runner-analysis-list">
                        {topAgents.map((agent) => (
                            <div
                                className="runner-analysis-row"
                                key={agent.agentId}
                            >
                                <strong>{agent.agentId}</strong>
                                <span
                                    className={`pill ${distributedProgressTone(agent.execution)}`}
                                >
                                    {agent.execution}
                                </span>
                                <small>
                                    ack {agent.readiness} - barrier {agent.barrier} - failures{' '}
                                    {agent.failedCommandCount}
                                </small>
                                <small>
                                    events {agent.eventCount} - reconnects {agent.reconnectCount ?? 0} - heartbeat{' '}
                                    {formatTime(agent.lastHeartbeatAtEpochMs)}
                                </small>
                            </div>
                        ))}
                        {topAgents.length === 0 && <div className="empty-state">No agents</div>}
                    </div>
                </section>
                <section>
                    <h3>Recipes</h3>
                    <div className="runner-analysis-list">
                        {topRecipes.map((recipe) => (
                            <div
                                className="runner-analysis-row"
                                key={`${recipe.recipeId}-${recipe.role ?? 'all'}`}
                            >
                                <strong>{recipe.recipeId}</strong>
                                <span
                                    className={`pill ${
                                        recipe.failedCount > 0 ? 'bad' : recipe.passedCount > 0 ? 'good' : 'muted'
                                    }`}
                                >
                                    {recipe.failedCount > 0
                                        ? 'failed'
                                        : recipe.passedCount > 0
                                        ? 'passed'
                                        : 'pending'}
                                </span>
                                <small>
                                    passed {recipe.passedCount} - failed {recipe.failedCount} - running{' '}
                                    {recipe.runningCount} - missing {recipe.missingCount}
                                </small>
                                <small>
                                    {recipe.role ?? 'all roles'} - {recipe.profile ?? 'default'} - targets{' '}
                                    {recipe.targetCount}
                                </small>
                            </div>
                        ))}
                        {topRecipes.length === 0 && <div className="empty-state">No recipe rows</div>}
                    </div>
                </section>
                <section>
                    <h3>Diagnostics</h3>
                    <div className="runner-analysis-list">
                        <div className="runner-analysis-row">
                            <strong>
                                {report.diagnostics.errors} errors, {report.diagnostics.warnings} warnings
                            </strong>
                            <span
                                className={`pill ${
                                    report.diagnostics.errors > 0
                                        ? 'bad'
                                        : report.diagnostics.warnings > 0
                                        ? 'warn'
                                        : 'good'
                                }`}
                            >
                                {report.diagnostics.total} total
                            </span>
                            <small>
                                WS {report.diagnostics.ws} - RTC {report.diagnostics.rtc}
                            </small>
                        </div>
                        {diagnostics.map((diagnostic) => (
                            <div
                                className="runner-analysis-row"
                                key={diagnostic.eventId}
                            >
                                <strong>{diagnostic.message}</strong>
                                <span
                                    className={`pill ${distributedDiagnosticTone(diagnostic.severity)}`}
                                >
                                    {diagnostic.severity}
                                </span>
                                <small>
                                    {diagnostic.transport ?? 'runtime'} - {diagnostic.agentId} -{' '}
                                    {diagnostic.commandId ?? 'no command'}
                                </small>
                                <small>{diagnostic.summary}</small>
                            </div>
                        ))}
                    </div>
                </section>
            </div>
            <details className="runner-analysis-raw">
                <summary>Raw Evidence</summary>
                <pre className="mini-json">{json(report.rawEvidence)}</pre>
            </details>
        </section>
    );
}
