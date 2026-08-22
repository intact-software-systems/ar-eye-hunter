import { parseRecipeConsoleUrl } from '../routing/url-state-codec.ts';
import { createAnalyzeWorkspaceContext, type AnalyzeWorkspaceContext } from './analyze-workspace-state.ts';

export function resolveAnalyzeOperationContext(
    input: Readonly<{
        baseUrl: string;
        renderedContext?: AnalyzeWorkspaceContext;
        search?: string;
    }>
): AnalyzeWorkspaceContext | undefined {
    if (input.search === undefined) {
        return input.renderedContext;
    }
    const state = parseRecipeConsoleUrl(input.search).state;
    if (!state.distributedRunId) {
        return input.renderedContext;
    }
    if (
        !state.controlRunId &&
        input.renderedContext?.distributedRunId !== state.distributedRunId
    ) {
        return undefined;
    }
    const context = createAnalyzeWorkspaceContext({
        baseUrl: input.baseUrl,
        controlRunId: state.controlRunId ?? input.renderedContext?.controlRunId,
        distributedRunId: state.distributedRunId
    });
    return context.key === input.renderedContext?.key
        ? input.renderedContext
        : context;
}
