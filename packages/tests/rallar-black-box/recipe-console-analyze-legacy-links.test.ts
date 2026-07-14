import { describe, expect, it } from 'vitest';
import {
    createAnalyzeLegacyRunsHref,
    createAnalyzeLegacySharedTestHref,
} from '../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-legacy-links.ts';
import type { RecipeConsoleUrlState } from '../../../apps/rallar-black-box/src/recipe-console/routing/url-state-contract.ts';

const state: RecipeConsoleUrlState = {
    v: 1,
    experience: 'recipe-console',
    view: 'analyze',
    controlRunId: 'control one',
    distributedRunId: 'distributed/one',
    agentId: 'agent-a',
    recipeId: 'recipe-a',
    commandId: 'command-a',
};

describe('Recipe Console Analyze legacy handoff links', () => {
    it('preserves selected run evidence in the legacy Runs deep link', () => {
        const href = createAnalyzeLegacyRunsHref(
            state,
            '?provider=browser-rallar&controlToken=secret',
        );
        const url = new URL(href, 'http://localhost');

        expect(url.searchParams.get('experience')).toBe('legacy');
        expect(url.searchParams.get('workspace')).toBe('black-box-runner');
        expect(url.searchParams.get('tab')).toBe('runs');
        expect(url.searchParams.get('provider')).toBe('browser-rallar');
        expect(url.searchParams.get('controlRunId')).toBe('control one');
        expect(url.searchParams.get('distributedRunId')).toBe('distributed/one');
        expect(url.searchParams.get('agentId')).toBe('agent-a');
        expect(url.searchParams.has('controlToken')).toBe(false);
    });

    it('opens the legacy Shared Test importer without leaking unsupported query data', () => {
        const href = createAnalyzeLegacySharedTestHref(
            '?provider=evil&accessToken=secret',
        );
        const url = new URL(href, 'http://localhost');

        expect(url.searchParams.get('experience')).toBe('legacy');
        expect(url.searchParams.get('workspace')).toBe('black-box-runner');
        expect(url.searchParams.get('tab')).toBe('advanced');
        expect(url.searchParams.get('advancedSurface')).toBe('shared-test');
        expect(url.searchParams.has('provider')).toBe(false);
        expect(url.searchParams.has('accessToken')).toBe(false);
    });
});
