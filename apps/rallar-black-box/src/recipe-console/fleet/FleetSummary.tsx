import type { FleetReportAnalysis } from '@shared-test/rallar-bb-test/fleet-report-analysis.ts';
import styles from './FleetSummary.module.css';

type FleetLiveSummary = Readonly<{
    total: number;
    connected: number;
    targetable: number;
    active: number;
}>;

export function FleetSummary({
    analysis,
    collection = 'present',
    live
}: Readonly<{
    analysis?: FleetReportAnalysis;
    collection?: 'absent' | 'present';
    live: FleetLiveSummary;
}>) {
    const summary = analysis?.summary;
    const unavailable = collection === 'absent';
    const hasHistoricalEvidence = !unavailable && (summary?.runs ?? 0) > 0;
    return (
        <section aria-labelledby="fleet-status-heading" className={styles.root}>
            <div className={styles.heading}>
                <div>
                    <span className={styles.eyebrow}>Operator ledger</span>
                    <h2 id="fleet-status-heading">Fleet status</h2>
                </div>
                <p>
                    {live.connected.toLocaleString('en-US')} of {live.total.toLocaleString('en-US')}{' '}
                    live agents connected
                </p>
            </div>
            {unavailable ? <p className={styles.unavailable}>Report evidence unavailable</p> : null}
            <dl className={styles.metrics}>
                <Metric
                    label="Runs"
                    value={unavailable
                        ? 'Unavailable'
                        : count(summary?.runs, 'runs')}
                />
                <Metric
                    label="Agents"
                    value={unavailable
                        ? 'Unavailable'
                        : count(summary?.agents, 'agents')}
                />
                <Metric
                    label="Regions"
                    value={unavailable
                        ? 'Unavailable'
                        : count(summary?.regions, 'regions')}
                />
                <Metric
                    label="Pass rate"
                    value={unavailable
                        ? 'Unavailable'
                        : summary
                        ? `${percent(summary.passRate)} pass rate`
                        : 'No evidence'}
                    tone={!hasHistoricalEvidence
                        ? undefined
                        : summary && summary.passRate < 1
                        ? 'warning'
                        : 'passed'}
                />
                <Metric
                    label="Repeated failures"
                    value={unavailable
                        ? 'Unavailable'
                        : count(summary?.failureGroups, 'groups')}
                    tone={!hasHistoricalEvidence
                        ? undefined
                        : summary?.failureGroups
                        ? 'failed'
                        : 'passed'}
                />
                <Metric
                    label="Run p95"
                    value={summary?.p95DurationMs === undefined
                        ? 'Unavailable'
                        : `${number(summary.p95DurationMs)} ms`}
                />
            </dl>
        </section>
    );
}

function Metric({
    label,
    tone,
    value
}: Readonly<{
    label: string;
    tone?: 'passed' | 'warning' | 'failed';
    value: string;
}>) {
    return (
        <div className={styles.metric} data-tone={tone}>
            <dt>{label}</dt>
            <dd>{value}</dd>
        </div>
    );
}

function count(value: number | undefined, label: string): string {
    return `${number(value ?? 0)} ${label}`;
}

function number(value: number): string {
    return value.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

function percent(value: number): string {
    return `${
        (value * 100).toLocaleString('en-US', {
            maximumFractionDigits: 1
        })
    }%`;
}
