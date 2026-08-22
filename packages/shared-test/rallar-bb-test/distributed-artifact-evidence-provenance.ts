import type { DistributedRunArtifactFiles } from './distributed-artifact-analysis.ts';

export function distributedArtifactEvidenceSourceFile(
    input: Readonly<{
        sourceFileNames: ReadonlySet<string>;
        sourceFiles?: DistributedRunArtifactFiles;
        parsedControlRun?: Readonly<Record<string, unknown>>;
    }>,
    controlField: 'results' | 'events',
    jsonlFile: 'results.jsonl' | 'events.jsonl'
): string {
    const controlRun = input.parsedControlRun ??
        jsonRecord(input.sourceFiles?.['control-run.json']);
    if (
        Array.isArray(controlRun[controlField]) &&
        controlRun[controlField].length > 0
    ) {
        return 'control-run.json';
    }
    if (input.sourceFiles?.[jsonlFile] !== undefined) {
        return jsonlFile;
    }
    return input.sourceFileNames.has('control-run.json')
        ? 'control-run.json'
        : jsonlFile;
}

function jsonRecord(text: string | undefined): Record<string, unknown> {
    if (text === undefined) {
        return {};
    }
    try {
        const parsed: unknown = JSON.parse(text);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {};
    }
    catch {
        return {};
    }
}
