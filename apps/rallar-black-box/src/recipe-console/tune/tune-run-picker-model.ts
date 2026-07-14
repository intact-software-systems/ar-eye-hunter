import type { SearchableListboxOption } from
    '../ui/searchable-listbox-model.ts';
import type { TuneRunOption } from './tune-run-catalog.ts';
import type { TuneSelectionModel } from './tune-selection-model.ts';

export type TuneRunPickerWork = Readonly<{
    runOptionsVisited: number;
    pickerOptionsProjected: number;
}>;

export type TuneRunPickerModel = Readonly<{
    byId: ReadonlyMap<string, TuneRunOption>;
    options: readonly SearchableListboxOption[];
    revisionKey: string;
    work: TuneRunPickerWork;
}>;

export function createTuneRunPickerModel(
    selection: TuneSelectionModel,
): TuneRunPickerModel {
    const options: SearchableListboxOption[] = [];
    let revisionKey = 'tune-run-picker-v1:';
    for (const option of selection.options) {
        const projected = {
            key: option.distributedRunId,
            value: option.distributedRunId,
            label: `${option.distributedRun.state} · ${option.pairStatus}`,
            exactIdentifier: option.distributedRunId,
            searchText: [
                option.distributedRunId,
                option.controlRunId,
                option.distributedRun.state,
                option.pairStatus,
                option.source,
                option.manifestValidation,
            ].join(' '),
            detail: `${option.source} · control ${option.controlRunId} · ${
                option.manifestValidation === 'validated'
                    ? 'manifest validated'
                    : 'validates on selection'
            }`,
        } satisfies SearchableListboxOption;
        options.push(projected);
        const revisionRow = JSON.stringify(projected);
        revisionKey += `${revisionRow.length}:${revisionRow}`;
    }
    return {
        byId: selection.optionsByDistributedRunId,
        options,
        revisionKey,
        work: {
            runOptionsVisited: selection.options.length,
            pickerOptionsProjected: options.length,
        },
    };
}
