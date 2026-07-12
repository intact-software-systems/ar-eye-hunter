import type { RecipeConsoleControlConnection } from '../control/ControlConnectionProvider.tsx';
import type {
    AnalyzeWorkspaceAction,
    AnalyzeWorkspaceContext,
} from './analyze-workspace-state.ts';

export function createAnalyzeImportLabel(
    fileNames: readonly string[],
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
    error: unknown,
): string | undefined {
    if (error === undefined) return undefined;
    return error instanceof Error ? error.message : String(error);
}

export function projectAnalyzeWorkspaceLoadReason(
    context: AnalyzeWorkspaceContext | undefined,
    execution: RecipeConsoleControlConnection['execution'],
    busyAction: AnalyzeWorkspaceAction | undefined,
): string | undefined {
    if (busyAction) return 'Another artifact operation is still running.';
    if (!context) return 'Select a distributed run to load its control artifact.';
    if (!execution) return 'The configured control endpoint cannot load artifacts.';
    return undefined;
}

export function validateAnalyzeControlArtifactIdentity(
    artifact: Readonly<{
        distributedRunId: string;
        controlRunId?: string;
    }>,
    context: AnalyzeWorkspaceContext,
): void {
    if (artifact.distributedRunId !== context.distributedRunId) {
        throw new Error(
            `Artifact response belongs to ${artifact.distributedRunId}, not ${context.distributedRunId}.`,
        );
    }
    if (
        context.controlRunId &&
        artifact.controlRunId !== context.controlRunId
    ) {
        throw new Error(
            `Artifact response belongs to control run ${artifact.controlRunId ?? 'unknown'}, not ${context.controlRunId}.`,
        );
    }
}
