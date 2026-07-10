import { useMemo } from 'react';
import type { ControlRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { SearchableWindowedListbox } from '../ui/SearchableWindowedListbox.tsx';
import { createExecuteControlRunListboxModel } from
    './execute-control-run-listbox-model.ts';
import styles from './ExecuteTargets.module.css';

export function ExecuteControlRunPicker({
    controlRunId,
    controlRuns,
    disabled,
    issueId,
    onSelect,
}: Readonly<{
    controlRunId?: string;
    controlRuns: readonly ControlRunSnapshot[];
    disabled: boolean;
    issueId?: string;
    onSelect(controlRunId: string): void;
}>) {
    const model = useMemo(
        () => createExecuteControlRunListboxModel(controlRuns),
        [controlRuns],
    );
    const revision = useMemo(
        () => ({ key: model.revisionKey }),
        [model.revisionKey],
    );
    return (
        <div className={styles.runChoice} data-execute-control-run-picker>
            <SearchableWindowedListbox
                contextKey="execute-control-runs-v1"
                describedBy={issueId}
                disabled={disabled}
                id="execute-control-run"
                label="Control run"
                layout="inline"
                invalid={issueId !== undefined}
                onSelect={option => onSelect(option.value)}
                options={model.options}
                placeholder={controlRuns.length === 0
                    ? 'Control runs unavailable'
                    : 'Select a control run'}
                revision={revision}
                selectedKey={controlRunId}
            />
        </div>
    );
}
