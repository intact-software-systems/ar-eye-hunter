import type { AnalyzeWorkspaceOperationAuthority } from './analyze-workspace-state.ts';

export function analyzeOperationOwnsCurrentBoundary(
    input: Readonly<{
        authority: Pick<AnalyzeWorkspaceOperationAuthority, 'action' | 'contextKey'>;
        operationExecution?: unknown;
        currentContextKey?: string;
        currentExecution?: unknown;
    }>
): boolean {
    if (input.authority.action !== 'load-control') {
        return true;
    }
    return input.authority.contextKey === input.currentContextKey &&
        input.operationExecution !== undefined &&
        input.operationExecution === input.currentExecution;
}
