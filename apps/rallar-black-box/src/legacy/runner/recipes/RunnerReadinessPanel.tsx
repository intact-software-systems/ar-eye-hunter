import type { RunnerReadinessCheck } from '../../../runner-readiness.ts';
import { runnerReadinessCheckTone } from './runner-launch-presentation.ts';

export function RunnerReadinessPanel({
    checks,
    message,
    refreshing,
    onRefresh,
    onOpenAgentTabs
}: {
    checks: readonly RunnerReadinessCheck[];
    message: string;
    refreshing: boolean;
    onRefresh(): void;
    onOpenAgentTabs?(): void;
}) {
    return (
        <section className="runner-readiness-panel" aria-label="Runner Readiness">
            <div className="section-heading">
                <h3>Runner Readiness</h3>
                <button type="button" disabled={refreshing} onClick={onRefresh}>
                    {refreshing ? 'Checking...' : 'Refresh'}
                </button>
            </div>
            <div className="runner-readiness-grid">
                {checks.map((check) => (
                    <article
                        className={`runner-readiness-check ${runnerReadinessCheckTone(check)}`}
                        key={check.id}
                    >
                        <div>
                            <strong>{check.label}</strong>
                            <span className={`pill ${runnerReadinessCheckTone(check)}`}>
                                {check.status}
                            </span>
                        </div>
                        <p>{check.message}</p>
                        {check.action && <small>{check.action}</small>}
                        {check.id === 'agents' && onOpenAgentTabs && (
                            <button
                                type="button"
                                className="runner-readiness-inline-action"
                                onClick={onOpenAgentTabs}
                            >
                                Open agent tabs
                            </button>
                        )}
                    </article>
                ))}
            </div>
            <div className="runner-readiness-summary" role="status">
                {message}
            </div>
        </section>
    );
}
