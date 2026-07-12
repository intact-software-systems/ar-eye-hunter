import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import { SegmentedControl } from '../ui/SegmentedControl.tsx';
import type { TuneSelectionModel } from './tune-selection-model.ts';
import type { TuneSourceModel } from './tune-source-model.ts';
import {
    tuneLeftSelectionPatch,
    tuneRightSelectionPatch,
    tuneTimingMetricPatch,
} from './tune-url-patches.ts';
import styles from './TuneEvidence.module.css';

const TIMING_OPTIONS = [
    { value: 'command-duration', label: 'Command' },
    { value: 'stream-send-duration', label: 'Send duration' },
    { value: 'stream-drift', label: 'Drift' },
    { value: 'stream-cadence', label: 'Cadence' },
] as const;

export function TuneSourceSelection({
    selection,
    source,
    urlState,
    navigate,
}: Readonly<{
    selection: TuneSelectionModel;
    source: TuneSourceModel;
    urlState: RecipeConsoleUrlState;
    navigate(patch: Partial<RecipeConsoleUrlState>): void;
}>) {
    const candidateValue = urlState.compareRight ?? '';
    return (
        <section className={styles.source} data-tune-source>
            <header className={styles.sectionHeader}>
                <div>
                    <p className={styles.eyebrow}>Signal ledger</p>
                    <h2>Evidence source</h2>
                </div>
                <p className={styles.provenance}>
                    {source.provenance.source} · {source.provenance.detail}
                </p>
            </header>
            <div className={styles.selectors}>
                <label>
                    <span>Baseline run</span>
                    <select
                        onChange={event => {
                            const option = selection.options.find(row =>
                                row.distributedRunId === event.currentTarget.value
                            );
                            if (option) navigate(tuneLeftSelectionPatch(option));
                        }}
                        value={urlState.compareLeft ?? ''}
                    >
                        <option disabled value="">Select baseline</option>
                        {selection.options.map(option => (
                            <option key={option.key} value={option.distributedRunId}>
                                {option.distributedRunId}
                            </option>
                        ))}
                    </select>
                </label>
                <label>
                    <span>Candidate run</span>
                    <select
                        onChange={event => {
                            const option = selection.options.find(row =>
                                row.distributedRunId === event.currentTarget.value
                            );
                            if (option) navigate(tuneRightSelectionPatch(option));
                        }}
                        value={candidateValue}
                    >
                        <option disabled value="">Select candidate</option>
                        {selection.options.map(option => (
                            <option key={option.key} value={option.distributedRunId}>
                                {option.distributedRunId}
                            </option>
                        ))}
                    </select>
                </label>
                <div className={styles.metricSelector}>
                    <span>Timing metric</span>
                    <SegmentedControl
                        label="Timing metric"
                        onChange={metric => navigate(tuneTimingMetricPatch(metric))}
                        options={TIMING_OPTIONS}
                        value={urlState.timingMetric ?? 'command-duration'}
                    />
                </div>
            </div>
            {source.issues.length > 0 ? (
                <ul className={styles.issues}>
                    {source.issues.map(issue => (
                        <li key={issue.code}>{issue.message}</li>
                    ))}
                </ul>
            ) : (
                <p className={styles.authority}>
                    Focus authority · {source.focusRunId ?? 'No run selected'}
                </p>
            )}
        </section>
    );
}
