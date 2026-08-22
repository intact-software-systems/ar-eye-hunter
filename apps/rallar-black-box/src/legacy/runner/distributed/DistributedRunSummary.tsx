import type { ControlDistributedRunSnapshot } from '../../../control-run-manager.ts';
import { distributedRecipeStateTone } from '../../../distributed-recipes.ts';
import { json } from '../../shared/json-presentation.ts';
import { Metric } from '../../shared/Metric.tsx';

export function DistributedRunSummary({
    run
}: {
    run: ControlDistributedRunSnapshot;
}) {
    return (
        <div className="distributed-run-summary">
            <Metric
                label="State"
                value={run.state}
                tone={distributedRecipeStateTone(run.state)}
            />
            <Metric label="Targets" value={String(run.targetAgentIds.length)} />
            <Metric label="Commands" value={String(run.commandLinks.length)} />
            <Metric
                label="Ready"
                value={String(run.rollup.summary.readyParticipants)}
                tone="active"
            />
            <Metric
                label="Passed"
                value={String(run.rollup.summary.passedRecipes)}
                tone="good"
            />
            <Metric
                label="Failures"
                value={String(run.rollup.summary.blockingFailures)}
                tone={run.rollup.summary.blockingFailures > 0 ? 'bad' : 'muted'}
            />
            {run.error && (
                <div className="distributed-run-error">
                    <strong>{run.error.code}</strong>
                    <span>{run.error.message}</span>
                </div>
            )}
            {run.rollup.failures.length > 0 && (
                <details className="distributed-run-raw-failures">
                    <summary>Raw rollup failures</summary>
                    <pre className="mini-json">
                        {json(run.rollup.failures.slice(0, 6))}
                    </pre>
                </details>
            )}
        </div>
    );
}
