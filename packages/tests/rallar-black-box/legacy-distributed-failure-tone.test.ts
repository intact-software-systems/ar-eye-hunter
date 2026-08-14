import { describe, expect, it } from 'vitest';
import {
    distributedFailureCategoryTone,
} from '../../../apps/rallar-black-box/src/legacy/runner/distributed/status-presentation.ts';
import {
    RECIPE_CONSOLE_FAILURE_CATEGORIES,
} from '../../../apps/rallar-black-box/src/recipe-console/routing/url-state-contract.ts';

describe('legacy distributed failure category tone', () => {
    it('marks group assertion failures as blocking', () => {
        expect(distributedFailureCategoryTone('group-assertion')).toBe('bad');
    });

    // A category an operator can filter by is a category the analyzer emits, so
    // leaving it toneless would render a real failure as neutral chrome.
    it('gives every filterable category a meaningful tone', () => {
        const toneless = RECIPE_CONSOLE_FAILURE_CATEGORIES
            .filter(category => category !== 'unknown')
            .filter(category => distributedFailureCategoryTone(category) === 'muted');

        expect(toneless).toEqual([]);
        expect(distributedFailureCategoryTone('unknown')).toBe('muted');
    });
});
