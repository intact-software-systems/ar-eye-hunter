import { describe, expect, it } from 'vitest';
import { ControlRunManagerHttpError } from '../../../apps/rallar-black-box/src/control-http-error.ts';
import { analyzeFilterClearPatch } from '../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-selection.ts';
import {
    createAnalyzeImportLabel,
    projectAnalyzeWorkspaceError,
    projectAnalyzeWorkspaceLoadReason
} from '../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-workspace-policy.ts';
import { createAnalyzeWorkspaceContext } from '../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-workspace-state.ts';

describe('Recipe Console Analyze binding policy', () => {
    it('labels one envelope distinctly and summarizes directory intake', () => {
        expect(createAnalyzeImportLabel(['run-artifact.json']))
            .toBe('run-artifact.json');
        expect(createAnalyzeImportLabel([
            'distributed-run.json',
            'manifest.json',
            'failures.json'
        ])).toBe('3 artifact files');
    });

    it('explains every unavailable control-load boundary in precedence order', () => {
        const context = createAnalyzeWorkspaceContext({
            baseUrl: 'http://control.test',
            distributedRunId: 'distributed-1'
        });
        const execution = {} as Parameters<typeof projectAnalyzeWorkspaceLoadReason>[1];

        expect(projectAnalyzeWorkspaceLoadReason(undefined, execution, undefined))
            .toContain('Select a distributed run');
        expect(projectAnalyzeWorkspaceLoadReason(context, undefined, undefined))
            .toContain('cannot load artifacts');
        expect(projectAnalyzeWorkspaceLoadReason(context, execution, 'load-control'))
            .toContain('still running');
        expect(projectAnalyzeWorkspaceLoadReason(context, execution, undefined))
            .toBeUndefined();
    });

    it('projects retained operation errors without discarding useful messages', () => {
        expect(projectAnalyzeWorkspaceError(new Error('identity mismatch')))
            .toBe('identity mismatch');
        expect(projectAnalyzeWorkspaceError(new ControlRunManagerHttpError('Artifact is gone', 404, 'Not Found')))
            .toBe('The selected Control artifact is unavailable. It may have expired or been removed.');
        expect(projectAnalyzeWorkspaceError(undefined)).toBeUndefined();
    });

    it('clears only Analyze evidence filters and keeps run identity intact', () => {
        expect(analyzeFilterClearPatch()).toEqual({
            agentId: undefined,
            recipeId: undefined,
            commandId: undefined,
            diagnosticSeverity: undefined,
            transport: undefined,
            historyQuery: undefined,
            status: undefined,
            from: undefined,
            to: undefined
        });
        expect(analyzeFilterClearPatch()).not.toHaveProperty('controlRunId');
        expect(analyzeFilterClearPatch()).not.toHaveProperty('distributedRunId');
    });
});
