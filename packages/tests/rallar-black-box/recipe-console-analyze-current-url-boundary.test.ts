import { describe, expect, it } from 'vitest';
import { resolveAnalyzeOperationContext } from
    '../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-current-url-boundary.ts';
import { createAnalyzeWorkspaceContext } from
    '../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-workspace-state.ts';

const renderedContext = createAnalyzeWorkspaceContext({
    baseUrl: 'https://control.test',
    controlRunId: 'rendered-control',
    distributedRunId: 'rendered-run',
});

describe('Recipe Console Analyze current URL boundary', () => {
    it('uses the current URL identity when an action follows popstate before React commits', () => {
        expect(resolveAnalyzeOperationContext({
            baseUrl: 'https://control.test',
            renderedContext,
            search: '?v=1&experience=recipe-console&view=analyze' +
                '&controlRunId=current-control&distributedRunId=current-run',
        })).toEqual(createAnalyzeWorkspaceContext({
            baseUrl: 'https://control.test',
            controlRunId: 'current-control',
            distributedRunId: 'current-run',
        }));
    });

    it('falls back to the rendered context when no complete URL identity exists', () => {
        expect(resolveAnalyzeOperationContext({
            baseUrl: 'https://control.test',
            renderedContext,
            search: '?v=1&experience=recipe-console&view=analyze',
        })).toBe(renderedContext);
        expect(resolveAnalyzeOperationContext({
            baseUrl: 'https://control.test',
            renderedContext,
        })).toBe(renderedContext);
    });

    it('preserves derived control authority only for the same URL distributed run', () => {
        expect(resolveAnalyzeOperationContext({
            baseUrl: 'https://control.test',
            renderedContext,
            search: '?v=1&experience=recipe-console&view=analyze' +
                '&distributedRunId=rendered-run',
        })).toBe(renderedContext);
        expect(resolveAnalyzeOperationContext({
            baseUrl: 'https://control.test',
            renderedContext,
            search: '?v=1&experience=recipe-console&view=analyze' +
                '&distributedRunId=new-run',
        })).toBeUndefined();
    });
});
