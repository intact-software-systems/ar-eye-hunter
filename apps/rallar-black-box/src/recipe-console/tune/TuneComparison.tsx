import type { TuneSelectionModel } from './tune-selection-model.ts';
import { tuneList, tuneSigned } from './tune-format.ts';
import styles from './TuneComparison.module.css';

export function TuneComparison({
    selection,
}: Readonly<{ selection: TuneSelectionModel }>) {
    const comparison = selection.comparison;
    const structural = comparison.structural;
    const comparisonSummary = [
        `Comparison state: ${comparison.state.replace('-', ' ')}.`,
        ...comparison.issues.map(issue => issue.message),
        ...comparison.compatibilityWarnings.map(warning => warning.message),
    ].join(' ');
    return (
        <section className={styles.comparison} data-tune-comparison>
            <header>
                <div>
                    <p>Explicit baseline and candidate</p>
                    <h2>Run comparison</h2>
                </div>
                <span>{comparison.state}</span>
            </header>
            <div className={styles.identities}>
                <code>{selection.left?.distributedRunId ?? 'No baseline selected'}</code>
                <span aria-hidden="true">→</span>
                <code>{selection.right?.distributedRunId ?? 'No candidate selected'}</code>
            </div>
            <p
                aria-atomic="true"
                aria-live="polite"
                className={styles.summary}
                data-state={comparison.state}
                role="status"
            >
                {comparisonSummary}
            </p>
            {comparison.compatibilityWarnings.length > 0 ? (
                <ul className={styles.warnings}>
                    {comparison.compatibilityWarnings.map(warning => (
                        <li key={warning.code}>{warning.message}</li>
                    ))}
                </ul>
            ) : null}
            {comparison.state === 'ready' && structural ? (
                <div className={styles.categories}>
                    <ComparisonCategory
                        category="recipe"
                        label="Recipe"
                        value={tuneList([
                            ...structural.recipeDelta.changedProfiles.map(value =>
                                value.replace(' -> ', ' → ')
                            ),
                            `Baseline only ${tuneList(structural.recipeDelta.leftOnly)}`,
                            `Candidate only ${tuneList(structural.recipeDelta.rightOnly)}`,
                        ])}
                    />
                    <ComparisonCategory
                        category="participant"
                        label="Participant"
                        value={`Baseline only ${tuneList(structural.participantDelta.leftOnly)} · Candidate only ${tuneList(structural.participantDelta.rightOnly)} · Shared ${tuneList(structural.participantDelta.shared)}`}
                    />
                    <ComparisonCategory
                        category="failure"
                        label="Failure"
                        value={`${structural.failureDelta.leftCount} → ${structural.failureDelta.rightCount} · Removed ${tuneList(structural.failureDelta.leftOnly)} · Added ${tuneList(structural.failureDelta.rightOnly)}`}
                    />
                    <ComparisonCategory
                        category="timing"
                        label="Timing"
                        value={`Duration ${tuneSigned(structural.timingDelta.durationDeltaMs, 'ms')} · Start ${tuneSigned(structural.timingDelta.startedDeltaMs, 'ms')} · Complete ${tuneSigned(structural.timingDelta.completedDeltaMs, 'ms')}`}
                    />
                    <ComparisonCategory
                        category="received-message"
                        label="Received message"
                        value={`${structural.receivedMessageDelta.leftCount} → ${structural.receivedMessageDelta.rightCount} · ${tuneSigned(structural.receivedMessageDelta.delta)}`}
                    />
                    {comparison.performance ? (
                        <ComparisonCategory
                            category="performance"
                            label="Selected performance"
                            value={`${comparison.performance.timingMetric} · ${comparison.performance.selected.statistic} ${tuneSigned(comparison.performance.selected.delta, comparison.performance.selected.unit)} · ${comparison.performance.availability}`}
                        />
                    ) : null}
                </div>
            ) : (
                <ul className={styles.issues}>
                    {comparison.issues.map(issue => (
                        <li key={`${issue.field}:${issue.code}`}>{issue.message}</li>
                    ))}
                </ul>
            )}
        </section>
    );
}

function ComparisonCategory({
    category,
    label,
    value,
}: Readonly<{ category: string; label: string; value: string }>) {
    return (
        <article data-compare-category={category}>
            <h3>{label}</h3>
            <p>{value}</p>
        </article>
    );
}
