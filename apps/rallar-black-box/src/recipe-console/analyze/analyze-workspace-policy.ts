import { ControlRunManagerHttpError } from '../../control-http-error.ts';
import type { RecipeConsoleControlConnection } from '../control/ControlConnectionProvider.tsx';
import type { AnalyzeWorkspaceAction, AnalyzeWorkspaceContext } from './analyze-workspace-state.ts';

export function createAnalyzeImportLabel(
    fileNames: readonly string[]
): string {
    return fileNames.length === 1
        ? fileNames[0] ?? 'Artifact file'
        : `${fileNames.length} artifact files`;
}

export function createAnalyzeInterruptedError(message: string): Error {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

export function projectAnalyzeWorkspaceError(
    error: Error | undefined
): string | undefined {
    if (error === undefined) {
        return undefined;
    }
    if (error instanceof ControlRunManagerHttpError && error.status === 404) {
        return 'The selected Control artifact is unavailable. It may have expired or been removed.';
    }
    return error.message;
}

export function projectAnalyzeWorkspaceLoadReason(
    context: AnalyzeWorkspaceContext | undefined,
    execution: RecipeConsoleControlConnection['execution'],
    busyAction: AnalyzeWorkspaceAction | undefined
): string | undefined {
    if (busyAction) {
        return 'Another artifact operation is still running.';
    }
    if (!context) {
        return 'Select a distributed run to load its control artifact.';
    }
    if (!execution) {
        return 'The configured control endpoint cannot load artifacts.';
    }
    return undefined;
}
