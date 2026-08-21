import { useMemo } from 'react';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import { SearchableWindowedListbox } from '../ui/SearchableWindowedListbox.tsx';
import type { TuneRunPickerModel } from './tune-run-picker-model.ts';
import type { TuneComparisonIssue, TuneSelectionModel } from './tune-selection-model.ts';
import { tuneLeftSelectionPatch, tuneRightSelectionPatch } from './tune-url-patches.ts';

export function TuneRunPicker({
    field,
    model,
    navigate,
    selection,
    selectedKey
}: Readonly<{
    field: TuneComparisonIssue['field'];
    model: TuneRunPickerModel;
    navigate(patch: Partial<RecipeConsoleUrlState>): void;
    selection: TuneSelectionModel;
    selectedKey?: string;
}>) {
    const revision = useMemo(() => Object.freeze({}), [model.revisionKey]);
    const issue = selection.comparison.issues.find((row) => row.field === field);
    const visibleIssue = issue?.code === 'missing' ? undefined : issue;
    const label = field === 'compareLeft' ? 'Baseline run' : 'Candidate run';
    const issueId = visibleIssue ? `tune-${field}-issue` : undefined;
    const placeholder = field === 'compareLeft'
        ? 'Select baseline'
        : 'Select candidate';

    return (
        <div data-tune-run-picker={field}>
            <SearchableWindowedListbox
                contextKey={`tune-run-picker-v1:${field}`}
                describedBy={issueId}
                id={`tune-${field}`}
                invalid={visibleIssue !== undefined}
                label={label}
                onSelect={(row) => {
                    const option = model.byId.get(row.value);
                    if (!option) {
                        return;
                    }
                    navigate(
                        field === 'compareLeft'
                            ? tuneLeftSelectionPatch(option)
                            : tuneRightSelectionPatch(option)
                    );
                }}
                options={model.options}
                placeholder={placeholder}
                revision={revision}
                selectedKey={selectedKey}
            />
            {visibleIssue
                ? (
                    <p data-tune-run-picker-issue id={issueId} role="status">
                        {visibleIssue.message}
                    </p>
                )
                : null}
        </div>
    );
}
