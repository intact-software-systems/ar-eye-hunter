import type { DistributedRunAnalysis } from '@shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import { distributedRecipeStateTone } from '../../../distributed-recipes.ts';
import { Metric } from '../../shared/Metric.tsx';
import { formatDuration } from '../../shared/time-format.ts';
import { CausalTrailPanel } from '../evidence/CausalTrailPanel.tsx';
import {
    formatFleetDuration,
    formatPercent,
    formatStreamRate,
} from '../shared/performance-format.ts';
import { shortRunId } from '../shared/run-id-presentation.ts';
import {
    DISTRIBUTED_ARTIFACT_REQUIRED_FILES,
    type DistributedArtifactImportStatus,
} from './distributed-artifact-import.ts';

export function ImportedDistributedArtifactAnalysisPanel({
    analysis,
    status,
}: {
    analysis: DistributedRunAnalysis;
    status?: DistributedArtifactImportStatus;
}) {
    const failure = analysis.failure;
    const performance = analysis.performance;
    const loadedRequiredCount = status?.requiredFiles.filter((file) => file.loaded).length ?? 0;
    const requiredFileCount = status?.requiredFiles.length ?? DISTRIBUTED_ARTIFACT_REQUIRED_FILES.length;
    const slowestAgent = performance?.slowestAgents[0];
    const streamTiming = performance?.streamTiming;
    const slowestStreamAgent = streamTiming?.slowestAgents[0];
    const artifactVerdict = analysis.spa?.verdict;
    const causalTrail = artifactVerdict?.causalTrail ?? [];
    const stateTone = analysis.ok
        ? 'good'
        : failure
        ? 'bad'
        : distributedRecipeStateTone(analysis.status);

    return (
        <section className="distributed-subpanel imported-distributed-artifact-analysis">
            <div className="section-heading">
                <h3>Imported CI artifact analysis</h3>
                <span className={`pill ${stateTone}`}>
                    {analysis.ok ? 'passed' : analysis.status}
                </span>
            </div>
            <div className="distributed-monitor-metrics">
                <Metric
                    label="Run"
                    value={shortRunId(analysis.distributedRunId)}
                    tone="active"
                />
                <Metric
                    label="Pass"
                    value={formatPercent(analysis.summary.passRate)}
                    tone={analysis.summary.passRate >= 1 ? 'good' : 'warn'}
                />
                <Metric label="Agents" value={String(analysis.summary.agents)} />
                <Metric
                    label="Warnings"
                    value={String(analysis.parseWarnings.length)}
                    tone={analysis.parseWarnings.length > 0 ? 'warn' : 'good'}
                />
                <Metric
                    label="Selected files"
                    value={status ? String(status.selectedFileCount) : '-'}
                    tone={status ? 'active' : 'muted'}
                />
                <Metric
                    label="Required files"
                    value={`${loadedRequiredCount}/${requiredFileCount}`}
                    tone={loadedRequiredCount === requiredFileCount ? 'good' : 'warn'}
                />
            </div>
            <div className="imported-artifact-band">
                <div className="section-heading compact">
                    <h4>{failure ? 'Verdict and Fix' : 'Verdict'}</h4>
                    <span>{failure ? failure.minimalFixArea : 'passed'}</span>
                </div>
                {failure ? (
                    <div className="runner-analysis-first-failure">
                        <div>
                            <span className="eyebrow">Focus</span>
                            <h4>{failure.title}</h4>
                            <p>{failure.likelyCause}</p>
                            <small>{failure.nextAction}</small>
                        </div>
                        <dl>
                            <div>
                                <dt>Fix area</dt>
                                <dd>{failure.minimalFixArea}</dd>
                            </div>
                            <div>
                                <dt>Evidence</dt>
                                <dd>{failure.evidenceFile}</dd>
                            </div>
                            <div>
                                <dt>Agents</dt>
                                <dd>{failure.affectedAgents.join(', ') || '-'}</dd>
                            </div>
                            <div>
                                <dt>Command</dt>
                                <dd>{failure.commandId ?? '-'}</dd>
                            </div>
                            <div>
                                <dt>Verify</dt>
                                <dd>{failure.verificationCommand.replaceAll('`', '')}</dd>
                            </div>
                        </dl>
                    </div>
                ) : (
                    <div className="runner-analysis-warning success" role="status">
                        <strong>Performance baseline</strong>
                        <span>
                            {performance
                                ? `${formatDuration(performance.runDurationMs)} run, ${performance.reconnectCount} reconnects, ${performance.exportedEventCount} exported events`
                                : 'No performance artifact data was loaded.'}
                        </span>
                    </div>
                )}
            </div>
            {causalTrail.length > 0 && (
                <CausalTrailPanel items={causalTrail} />
            )}
            <div className="imported-artifact-band">
                <div className="section-heading compact">
                    <h4>Performance Health</h4>
                    <span>{performance ? `${performance.commandTiming.count} samples` : 'no samples'}</span>
                </div>
                <div className="distributed-monitor-metrics">
                    <Metric
                        label="P50 command"
                        value={formatFleetDuration(performance?.commandTiming.p50Ms)}
                        tone={performance?.commandTiming.p50Ms !== undefined ? 'active' : 'muted'}
                    />
                    <Metric
                        label="P95 command"
                        value={formatFleetDuration(performance?.commandTiming.p95Ms)}
                        tone={(performance?.commandTiming.p95Ms ?? 0) > 1_000 ? 'warn' : 'active'}
                    />
                    <Metric
                        label="P99 command"
                        value={formatFleetDuration(performance?.commandTiming.p99Ms)}
                        tone={(performance?.commandTiming.p99Ms ?? 0) > 2_000 ? 'warn' : 'active'}
                    />
                    <Metric
                        label="Max command"
                        value={formatFleetDuration(performance?.commandTiming.maxMs)}
                        tone={(performance?.commandTiming.maxMs ?? 0) > 2_000 ? 'warn' : 'active'}
                    />
                    <Metric
                        label="Outliers"
                        value={String(performance?.commandTiming.outlierCount ?? 0)}
                        tone={(performance?.commandTiming.outlierCount ?? 0) > 0 ? 'warn' : 'good'}
                    />
                    <Metric
                        label="Diagnostics"
                        value={String(performance?.diagnosticCount ?? 0)}
                        tone={(performance?.errorDiagnosticCount ?? 0) > 0
                            ? 'bad'
                            : (performance?.warningDiagnosticCount ?? 0) > 0
                            ? 'warn'
                            : 'good'}
                    />
                    <Metric
                        label="Stream frames"
                        value={streamTiming
                            ? `${streamTiming.completedFrames}/${streamTiming.plannedFrames}`
                            : '-'}
                        tone={streamTiming
                            ? streamTiming.completedFrames >= streamTiming.plannedFrames ? 'good' : 'warn'
                            : 'muted'}
                    />
                    <Metric
                        label="P50 stream"
                        value={formatFleetDuration(streamTiming?.duration.p50Ms)}
                        tone={streamTiming?.duration.p50Ms !== undefined ? 'active' : 'muted'}
                    />
                    <Metric
                        label="P95 stream"
                        value={formatFleetDuration(streamTiming?.duration.p95Ms)}
                        tone={(streamTiming?.duration.p95Ms ?? 0) > 1_000 ? 'warn' : 'active'}
                    />
                    <Metric
                        label="P99 stream"
                        value={formatFleetDuration(streamTiming?.duration.p99Ms)}
                        tone={(streamTiming?.duration.p99Ms ?? 0) > 2_000 ? 'warn' : 'active'}
                    />
                    <Metric
                        label="Stream drops"
                        value={String(streamTiming?.droppedFrames ?? 0)}
                        tone={(streamTiming?.droppedFrames ?? 0) > 0 ? 'bad' : 'good'}
                    />
                    <Metric
                        label="In-flight drops"
                        value={String(streamTiming?.inFlightLimitDropCount ?? 0)}
                        tone={(streamTiming?.inFlightLimitDropCount ?? 0) > 0 ? 'bad' : 'good'}
                    />
                    <Metric
                        label="Max drift"
                        value={formatFleetDuration(streamTiming?.maxStartDriftMs)}
                        tone={(streamTiming?.maxStartDriftMs ?? 0) > 1_000 ? 'warn' : 'active'}
                    />
                    <Metric
                        label="Late frames"
                        value={String(streamTiming?.lateFrameCount ?? 0)}
                        tone={(streamTiming?.lateFrameCount ?? 0) > 0 ? 'warn' : 'good'}
                    />
                    <Metric
                        label="Backpressure"
                        value={String(streamTiming?.backpressureCount ?? 0)}
                        tone={(streamTiming?.backpressureCount ?? 0) > 0 ? 'warn' : 'good'}
                    />
                    <Metric
                        label="Achieved Hz"
                        value={formatStreamRate(streamTiming?.achievedCompletionHz)}
                        tone={streamTiming?.achievedCompletionHz !== undefined ? 'active' : 'muted'}
                    />
                </div>
                {streamTiming && (
                    <div className="stream-frame-disposition" aria-label="Frame disposition">
                        <div className="section-heading compact">
                            <h4>Frame disposition</h4>
                            <span>{streamTiming.streamCount} stream samples</span>
                        </div>
                        <div className="stream-frame-disposition-grid">
                            <span className="good">
                                <strong>Completed</strong>
                                {streamTiming.completedFrames}
                            </span>
                            <span className={streamTiming.failedFrames > 0 ? 'bad' : 'good'}>
                                <strong>Failed</strong>
                                {streamTiming.failedFrames}
                            </span>
                            <span className={streamTiming.droppedFrames > 0 ? 'warn' : 'good'}>
                                <strong>Dropped</strong>
                                {streamTiming.droppedFrames}
                            </span>
                            <span className={streamTiming.inFlightLimitDropCount > 0 ? 'bad' : 'good'}>
                                <strong>In-flight drops</strong>
                                {streamTiming.inFlightLimitDropCount}
                            </span>
                        </div>
                    </div>
                )}
                {streamTiming && (
                    <div className="imported-artifact-slowest">
                        <strong>Slowest stream agent</strong>
                        <span>
                            {slowestStreamAgent
                                ? `${slowestStreamAgent.agentId} - max ${formatFleetDuration(slowestStreamAgent.maxMs)}, p99 ${formatFleetDuration(slowestStreamAgent.p99Ms)}, frames ${slowestStreamAgent.completedFrames}/${slowestStreamAgent.plannedFrames}`
                                : 'No stream latency rows'}
                        </span>
                    </div>
                )}
                <div className="imported-artifact-slowest">
                    <strong>Slowest agent</strong>
                    <span>
                        {slowestAgent
                            ? `${slowestAgent.agentId} - max ${formatFleetDuration(slowestAgent.maxMs)}, avg ${formatFleetDuration(slowestAgent.averageMs)}`
                            : 'No agent latency rows'}
                    </span>
                </div>
            </div>
            <div className="imported-artifact-band">
                <div className="section-heading compact">
                    <h4>Evidence Quality</h4>
                    <span>{status?.warningCount ?? analysis.parseWarnings.length} warnings</span>
                </div>
                {status && (
                    <div className="artifact-issue-list compact" role="status">
                        {status.requiredFiles.map((file) => (
                            <div
                                className={`artifact-issue-row ${file.loaded ? 'good' : 'warning'}`}
                                key={file.fileName}
                            >
                                <strong>{file.fileName}</strong>
                                <span>{file.loaded ? 'loaded' : 'missing'}</span>
                            </div>
                        ))}
                    </div>
                )}
                {analysis.parseWarnings.length > 0 && (
                    <div className="artifact-issue-list" role="status">
                        {analysis.parseWarnings.slice(0, 4).map((warning, index) => (
                            <div
                                className="artifact-issue-row warning"
                                key={`${warning.fileName}-${warning.lineNumber ?? 0}-${index}`}
                            >
                                <strong>{warning.fileName}</strong>
                                <span>{warning.message}</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </section>
    );
}
