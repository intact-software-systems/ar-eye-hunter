import type { AnalyzeArtifactModel } from './analyze-artifact-model.ts';
import styles from './AnalyzeEvidence.module.css';

export function AnalyzePerformance({
    model,
}: Readonly<{ model: AnalyzeArtifactModel }>) {
    const performance = model.analysis.performance;
    const timing = performance?.commandTiming;
    const stream = performance?.streamTiming;
    return (
        <section className={styles.panel} data-analyze-section="performance">
            <header className={styles.heading}>
                <div>
                    <p className={styles.eyebrow}>Performance summary</p>
                    <h2>Command and stream health</h2>
                </div>
                <span>{timing?.count ?? 0} command samples</span>
            </header>
            <dl className={styles.metrics}>
                <Metric label="Run" value={formatMs(performance?.runDurationMs)} />
                <Metric label="P50 command" value={formatMs(timing?.p50Ms)} />
                <Metric label="P95 command" value={formatMs(timing?.p95Ms)} warn={(timing?.p95Ms ?? 0) > 1_000} />
                <Metric label="P99 command" value={formatMs(timing?.p99Ms)} warn={(timing?.p99Ms ?? 0) > 2_000} />
                <Metric label="Reconnects" value={String(performance?.reconnectCount ?? 0)} warn={(performance?.reconnectCount ?? 0) > 0} />
                <Metric label="Diagnostics" value={String(performance?.diagnosticCount ?? 0)} warn={(performance?.errorDiagnosticCount ?? 0) > 0} />
                <Metric
                    label="Stream frames"
                    value={stream ? `${stream.completedFrames}/${stream.plannedFrames}` : 'Not available'}
                    warn={Boolean(stream && stream.completedFrames < stream.plannedFrames)}
                />
                <Metric label="Backpressure" value={String(stream?.backpressureCount ?? 0)} warn={(stream?.backpressureCount ?? 0) > 0} />
            </dl>
            <p className={styles.summaryLine}>
                {performance
                    ? `${performance.agentCount} agents · ${Math.round(performance.passRate * 100)}% pass · ${performance.exportedEventCount} exported events`
                    : 'No performance evidence was available in this bundle.'}
            </p>
        </section>
    );
}

function Metric({
    label,
    value,
    warn = false,
}: Readonly<{ label: string; value: string; warn?: boolean }>) {
    return (
        <div data-tone={warn ? 'warn' : 'neutral'}>
            <dt>{label}</dt>
            <dd>{value}</dd>
        </div>
    );
}

function formatMs(value: number | undefined): string {
    if (value === undefined) return 'Not available';
    if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)}s`;
    return `${Math.round(value)}ms`;
}
