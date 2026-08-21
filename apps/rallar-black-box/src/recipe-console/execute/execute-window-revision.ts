export function createExecuteWindowRevision<Value>(
    values: readonly Value[],
    project: (value: Value, index: number) => unknown
): string {
    return JSON.stringify([
        'execute-window-revision-v1',
        values.map(project)
    ]);
}
