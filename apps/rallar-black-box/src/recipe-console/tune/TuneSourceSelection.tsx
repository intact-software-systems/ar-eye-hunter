import { useMemo } from 'react';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import { SegmentedControl } from '../ui/SegmentedControl.tsx';
import { createTuneRunPickerModel } from './tune-run-picker-model.ts';
import type { TuneSelectionModel } from './tune-selection-model.ts';
import { tuneSourceIssueKey } from './tune-source-issue.ts';
import type { TuneSourceModel } from './tune-source-model.ts';
import { tuneTimingMetricPatch } from './tune-url-patches.ts';
import styles from './TuneEvidence.module.css';
import { TuneRunPicker } from './TuneRunPicker.tsx';

const TIMING_OPTIONS = [
    { value: 'command-duration', label: 'Command' },
    { value: 'stream-send-duration', label: 'Send duration' },
    { value: 'stream-drift', label: 'Drift' },
    { value: 'stream-cadence', label: 'Cadence' }
] as const;

export function TuneSourceSelection({
    selection,
    source,
    urlState,
    navigate
}: Readonly<{
    selection: TuneSelectionModel;
    source: TuneSourceModel;
    urlState: RecipeConsoleUrlState;
    navigate(patch: Partial<RecipeConsoleUrlState>): void;
}>) {
    const runPicker = useMemo(() => createTuneRunPickerModel(selection), [
        selection.options,
        selection.optionsByDistributedRunId
    ]);
    return (
        <section
            className={styles.source}
            data-tune-picker-options-projected={runPicker.work.pickerOptionsProjected}
            data-tune-picker-options-visited={runPicker.work.runOptionsVisited}
            data-tune-source
        >
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
                <TuneRunPicker
                    field="compareLeft"
                    model={runPicker}
                    navigate={navigate}
                    selectedKey={urlState.compareLeft}
                    selection={selection}
                />
                <TuneRunPicker
                    field="compareRight"
                    model={runPicker}
                    navigate={navigate}
                    selectedKey={urlState.compareRight}
                    selection={selection}
                />
                <div className={styles.metricSelector}>
                    <span>Timing metric</span>
                    <SegmentedControl
                        label="Timing metric"
                        onChange={(metric) => navigate(tuneTimingMetricPatch(metric))}
                        options={TIMING_OPTIONS}
                        value={urlState.timingMetric ?? 'command-duration'}
                    />
                </div>
            </div>
            {source.issues.length > 0
                ? (
                    <ul className={styles.issues}>
                        {source.issues.map((issue) => <li key={tuneSourceIssueKey(issue)}>{issue.message}</li>)}
                    </ul>
                )
                : (
                    <p className={styles.authority}>
                        Focus authority · {source.focusRunId ?? 'No run selected'}
                    </p>
                )}
        </section>
    );
}
