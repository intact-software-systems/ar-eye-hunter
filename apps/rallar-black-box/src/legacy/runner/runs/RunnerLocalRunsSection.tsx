import type {
    RallarBlackBoxTestResult,
    RallarBlackBoxTestRuntimeStatus,
    RallarBlackBoxTestStatsSnapshot
} from '@shared-test/rallar-bb-test/types.ts';
import type { ReactNode } from 'react';
import type { RallarBlackBoxControlSnapshot } from '../../../control-client.ts';
import { statusTone } from '../../shared/command-presentation.ts';
import { Metric } from '../../shared/Metric.tsx';
import { formatTime } from '../../shared/time-format.ts';

type RunnerLocalRunsSectionProps = Readonly<{
    runtimeStatus: RallarBlackBoxTestRuntimeStatus;
    commandCount: number;
    failureCount: number;
    eventCount: number;
    latestStats?: RallarBlackBoxTestStatsSnapshot;
    controlState: RallarBlackBoxControlSnapshot['state'];
    recentHistory: readonly RallarBlackBoxTestResult[];
    failurePanel: ReactNode;
    reportPanel: ReactNode;
}>;

export function RunnerLocalRunsSection({
    runtimeStatus,
    commandCount,
    failureCount,
    eventCount,
    latestStats,
    controlState,
    recentHistory,
    failurePanel,
    reportPanel
}: RunnerLocalRunsSectionProps) {
    return (
        <>
            <div className="runner-runs-summary-grid">
                <Metric
                    label="Runtime"
                    value={runtimeStatus}
                    tone={statusTone(runtimeStatus)}
                />
                <Metric label="Commands" value={String(commandCount)} />
                <Metric
                    label="Failures"
                    value={String(failureCount)}
                    tone={failureCount > 0 ? 'bad' : 'good'}
                />
                <Metric
                    label="Events"
                    value={String(eventCount)}
                    tone="active"
                />
                <Metric
                    label="Stats"
                    value={latestStats ? formatTime(latestStats.atEpochMs) : '-'}
                />
                <Metric
                    label="Control"
                    value={controlState}
                    tone={statusTone(controlState)}
                />
            </div>
            <div className="runner-runs-layout">
                <section className="runner-runs-subpanel">
                    <div className="section-heading">
                        <h3>Recent commands</h3>
                        <span>{recentHistory.length}</span>
                    </div>
                    <div className="run-manager-command-list">
                        {recentHistory.map((result, index) => (
                            <article
                                className="run-manager-command-row"
                                key={`${result.commandId}-${index}`}
                            >
                                <span>
                                    <strong>{result.commandId}</strong>
                                    <small>{result.kind}</small>
                                </span>
                                <span
                                    className={`pill ${result.ok ? 'good' : 'bad'}`}
                                >
                                    {result.ok ? 'ok' : 'failed'}
                                </span>
                            </article>
                        ))}
                        {recentHistory.length === 0 && <div className="empty-state">No local run yet</div>}
                    </div>
                </section>
                <section className="runner-runs-subpanel">
                    {failurePanel}
                </section>
                <section className="runner-runs-subpanel">
                    {reportPanel}
                </section>
            </div>
        </>
    );
}
