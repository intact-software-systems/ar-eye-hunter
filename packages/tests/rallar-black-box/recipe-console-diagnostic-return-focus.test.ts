import { describe, expect, it } from 'vitest';

import { shouldRestoreDiagnosticReturnFocus } from '../../../apps/rallar-black-box/src/recipe-console/routing/diagnostic-return-focus.ts';

const RECIPE_CONSOLE_URL = 'http://127.0.0.1:5176/?v=1&experience=recipe-console&view=monitor';

describe('Recipe Console diagnostic return focus', () => {
    it('restores focus only for a same-origin contextual legacy return', () => {
        expect(shouldRestoreDiagnosticReturnFocus(
            'http://127.0.0.1:5176/?experience=legacy&diagnosticContext=1&view=monitor',
            RECIPE_CONSOLE_URL
        )).toBe(true);
    });

    it.each([
        ['', RECIPE_CONSOLE_URL],
        [
            'https://example.test/?experience=legacy&diagnosticContext=1',
            RECIPE_CONSOLE_URL
        ],
        [
            'http://127.0.0.1:5176/?experience=legacy',
            RECIPE_CONSOLE_URL
        ],
        [
            'http://127.0.0.1:5176/?experience=legacy&diagnosticContext=2',
            RECIPE_CONSOLE_URL
        ],
        [
            'http://127.0.0.1:5176/?experience=legacy&diagnosticContext=1&diagnosticContext=1',
            RECIPE_CONSOLE_URL
        ],
        [
            'http://127.0.0.1:5176/?experience=legacy&experience=legacy&diagnosticContext=1',
            RECIPE_CONSOLE_URL
        ],
        [
            'http://127.0.0.1:5176/other?experience=legacy&diagnosticContext=1',
            RECIPE_CONSOLE_URL
        ],
        [
            'http://127.0.0.1:5176/?experience=recipe-console&diagnosticContext=1',
            RECIPE_CONSOLE_URL
        ],
        [
            'http://127.0.0.1:5176/?experience=legacy&diagnosticContext=1',
            'http://127.0.0.1:5176/?experience=legacy&view=monitor'
        ],
        [
            'http://127.0.0.1:5176/?experience=legacy&diagnosticContext=1',
            'http://127.0.0.1:5176/?v=2&experience=recipe-console&view=monitor'
        ],
        [
            'http://127.0.0.1:5176/?experience=legacy&diagnosticContext=1',
            'http://127.0.0.1:5176/?v=1&v=1&experience=recipe-console&view=monitor'
        ],
        ['not a url', RECIPE_CONSOLE_URL],
        [
            'http://127.0.0.1:5176/?experience=legacy&diagnosticContext=1',
            'not a url'
        ]
    ])('does not move focus for unrelated or invalid navigation %#', (
        referrer,
        currentHref
    ) => {
        expect(shouldRestoreDiagnosticReturnFocus(referrer, currentHref))
            .toBe(false);
    });
});
