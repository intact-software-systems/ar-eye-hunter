import { expect, test } from '@playwright/test';

import { startTownMatch } from './match-browser.ts';

test('player hoodie colors agree across local and remote views', async ({ browser }) => {
    test.setTimeout(60000);
    const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
    const [alice, bob] = await Promise.all(contexts.map((context) => context.newPage()));
    try {
        await startTownMatch([alice, bob]);
        const aliceColor = await alice.locator('#online-game').getAttribute('data-player-color');
        const bobColor = await bob.locator('#online-game').getAttribute('data-player-color');
        expect([aliceColor, bobColor].sort()).toEqual(['#347d79', '#bd7047']);
        await expect(alice.locator('#online-game')).toHaveAttribute('data-peer-color', bobColor!);
        await expect(bob.locator('#online-game')).toHaveAttribute('data-peer-color', aliceColor!);
        for (const [index, page] of [alice, bob].entries()) {
            const color = await page.locator('#online-game').getAttribute('data-player-color');
            await expect(page.locator('.you')).toHaveText(`YOU / ${color === '#347d79' ? 'TEAL' : 'COPPER'} HOODIE`);
            await page.screenshot({ path: test.info().outputPath(`player-colors-${index}.png`) });
        }
    }
    finally {
        await Promise.allSettled(contexts.map((context) => context.close()));
    }
});
