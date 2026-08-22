import { describe, expect, it } from 'vitest';
import { distributedFailureCategoryTone } from '../../../apps/rallar-black-box/src/legacy/runner/distributed/status-presentation.ts';
import { RECIPE_CONSOLE_FAILURE_CATEGORIES } from '../../../apps/rallar-black-box/src/recipe-console/routing/url-state-contract.ts';
import { RALLAR_BLACK_BOX_DISTRIBUTED_FAILURE_CATEGORIES } from '../../shared-test/rallar-bb-test/distributed-run-monitor.ts';

describe('legacy distributed failure category tone', () => {
    it('marks group assertion failures as blocking', () => {
        expect(distributedFailureCategoryTone('group-assertion')).toBe('bad');
    });

    // A category the analyzer emits but the console cannot filter is invisible
    // in History, so the console vocabulary is the analyzer vocabulary.
    it('keeps every analyzer failure category filterable in the console', () => {
        expect(RECIPE_CONSOLE_FAILURE_CATEGORIES)
            .toEqual(RALLAR_BLACK_BOX_DISTRIBUTED_FAILURE_CATEGORIES);
    });

    // A category left toneless renders a real failure as neutral chrome.
    it('gives every analyzer failure category a meaningful tone', () => {
        const toneless = RALLAR_BLACK_BOX_DISTRIBUTED_FAILURE_CATEGORIES
            .filter((category) => category !== 'unknown')
            .filter((category) => distributedFailureCategoryTone(category) === 'muted');

        expect(toneless).toEqual([]);
        expect(distributedFailureCategoryTone('unknown')).toBe('muted');
    });
});
