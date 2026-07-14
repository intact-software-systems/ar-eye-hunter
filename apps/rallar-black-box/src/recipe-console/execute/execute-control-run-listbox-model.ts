import type { ControlRunSnapshot } from
    '@shared-test/rallar-bb-test/control-snapshots.ts';
import type { SearchableListboxOption } from
    '../ui/searchable-listbox-model.ts';

export type ExecuteControlRunListboxModel = Readonly<{
    options: readonly SearchableListboxOption[];
    revisionKey: string;
}>;

export function createExecuteControlRunListboxModel(
    runs: readonly ControlRunSnapshot[],
): ExecuteControlRunListboxModel {
    const options = runs.map(run => ({
        key: run.runId,
        value: run.runId,
        label: `${run.agents.length} agent${run.agents.length === 1 ? '' : 's'}`,
        exactIdentifier: run.runId,
        searchText: `${run.runId} ${run.agents.length}`,
        detail: 'Control run',
    }));
    return {
        options,
        revisionKey: JSON.stringify([
            'execute-control-run-options-v1',
            options.map(option => [option.key, option.label]),
        ]),
    };
}
