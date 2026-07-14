import { useMemo } from 'react';
import { SearchableWindowedListbox } from
    '../ui/SearchableWindowedListbox.tsx';
import type { RecipeConsoleUrlState } from
    '../routing/url-state-contract.ts';
import type {
    TuneComparisonIssue,
    TuneSelectionModel,
} from './tune-selection-model.ts';
import type { TuneRunPickerModel } from './tune-run-picker-model.ts';
import {
    tuneLeftSelectionPatch,
    tuneRightSelectionPatch,
} from './tune-url-patches.ts';

export function TuneRunPicker({
    field,
    model,
    navigate,
    selection,
    selectedKey,
}: Readonly<{
    field: TuneComparisonIssue['field'];
    model: TuneRunPickerModel;
    navigate(patch: Partial<RecipeConsoleUrlState>): void;
    selection: TuneSelectionModel;
    selectedKey?: string;
}>) {
    const revision = useMemo(() => Object.freeze({}), [model.revisionKey]);
    const issue = selection.comparison.issues.find(row => row.field === field);
    const label = field === 'compareLeft' ? 'Baseline run' : 'Candidate run';
    const issueId = issue ? `tune-${field}-issue` : undefined;

    return (
        <div data-tune-run-picker={field}>
            <SearchableWindowedListbox
                contextKey={`tune-run-picker-v1:${field}`}
                describedBy={issueId}
                id={`tune-${field}`}
                invalid={issue !== undefined && issue.code !== 'missing'}
                label={label}
                onSelect={row => {
                    const option = model.byId.get(row.value);
                    if (!option) return;
                    navigate(field === 'compareLeft'
                        ? tuneLeftSelectionPatch(option)
                        : tuneRightSelectionPatch(option));
                }}
                options={model.options}
                placeholder={`Select ${label.toLocaleLowerCase('en-US')}`}
                revision={revision}
                selectedKey={selectedKey}
            />
            {issue ? (
                <p data-tune-run-picker-issue id={issueId} role="status">
                    {issue.message}
                </p>
            ) : null}
        </div>
    );
}
