import type { RtcPerformanceView } from '../../../../rtc-diagnostics.ts';
import { Metric } from '../../../shared/Metric.tsx';
import { formatDuration } from '../../../shared/time-format.ts';
import { RtcAgentMatrix } from './RtcAgentMatrix.tsx';
import { RtcDiagnosticsTimeseriesPanel } from './RtcDiagnosticsTimeseriesPanel.tsx';
import {
    RtcLatencyHistogram,
    RtcLatencyScatterChart,
} from './RtcLatencyCharts.tsx';
import { RtcPhaseWaterfall } from './RtcPhaseWaterfall.tsx';

export function RtcPerformancePanel({
    view,
    compact = false,
    showTimeseries = !compact,
}: {
    view: RtcPerformanceView;
    compact?: boolean;
    showTimeseries?: boolean;
}) {
    return (
        <section className={`rtc-performance-panel ${compact ? 'compact' : ''} runner-evidence-first`}>
            <div className="section-heading">
                <h3>RTC Performance</h3>
                <span>{view.summary.commandCount} commands</span>
            </div>
            <div className="rtc-performance-legend" aria-label="RTC performance legend">
                <span><i className="good" /> RTC ok</span>
                <span><i className="active" /> WS ok</span>
                <span><i className="bad" /> Failed</span>
                <span><i className="distributed" /> Agent aggregate</span>
                <span>Waterfall bars show measured duration when available, otherwise observed delta.</span>
            </div>
            <div className="rtc-performance-summary">
                <Metric
                    label="P50"
                    value={formatDuration(view.summary.p50Ms)}
                    tone="active"
                />
                <Metric
                    label="P95"
                    value={formatDuration(view.summary.p95Ms)}
                    tone={(view.summary.p95Ms ?? 0) > 250 ? 'warn' : 'good'}
                />
                <Metric
                    label="P99"
                    value={formatDuration(view.summary.p99Ms)}
                    tone={(view.summary.p99Ms ?? 0) > 500 ? 'warn' : 'active'}
                />
                <Metric
                    label="Max"
                    value={formatDuration(view.summary.maxMs)}
                    tone={(view.summary.maxMs ?? 0) > 500 ? 'bad' : 'active'}
                />
                <Metric
                    label="Failures"
                    value={String(view.summary.failureCount)}
                    tone={view.summary.failureCount > 0 ? 'bad' : 'good'}
                />
                <Metric
                    label="Messages"
                    value={String(view.summary.messageCount)}
                    tone="active"
                />
            </div>
            {view.emptyReasons.length > 0 && (
                <div className="rtc-performance-empty">
                    {view.emptyReasons.join(' - ')}
                </div>
            )}
            {showTimeseries && (
                <RtcDiagnosticsTimeseriesPanel series={view.timeseries} />
            )}
            <div className="rtc-performance-grid">
                <article className="rtc-chart-card">
                    <div>
                        <strong>Latency Scatter</strong>
                        <small>duration by command sequence</small>
                    </div>
                    {view.scatter.length > 0 ? (
                        <RtcLatencyScatterChart
                            points={view.scatter}
                            percentiles={view.summary}
                        />
                    ) : (
                        <div className="empty-state">No command latency yet</div>
                    )}
                </article>
                <article className="rtc-chart-card">
                    <div>
                        <strong>Latency Distribution</strong>
                        <small>bucketed command durations</small>
                    </div>
                    {view.histogram.length > 0 ? (
                        <RtcLatencyHistogram
                            buckets={view.histogram}
                            percentiles={view.summary}
                        />
                    ) : (
                        <div className="empty-state">No duration buckets yet</div>
                    )}
                </article>
                <article className="rtc-chart-card">
                    <div>
                        <strong>Observed Stage Timing</strong>
                        <small>duration payloads or observed deltas</small>
                    </div>
                    {view.phaseSpans.length > 0 ? (
                        <RtcPhaseWaterfall spans={view.phaseSpans} />
                    ) : (
                        <div className="empty-state">No phase timing yet</div>
                    )}
                </article>
                {!compact && (
                    <article className="rtc-chart-card wide">
                        <div>
                            <strong>Agent Lane Matrix</strong>
                            <small>expected, observed, ready, active</small>
                        </div>
                        <RtcAgentMatrix cells={view.agentMatrix} />
                    </article>
                )}
            </div>
        </section>
    );
}
