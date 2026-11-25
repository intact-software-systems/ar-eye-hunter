import {
    expect,
    test,
    type Browser
} from '@playwright/test';

import { startTownMatch } from './match-browser.ts';

for (const hostOffsetMs of [-2_000, 2_000]) {
    test(`browser clocks four seconds apart preserve play and bounded interruption (host ${hostOffsetMs} ms)`, async ({ playwright, browserName, launchOptions, headless, baseURL, ignoreHTTPSErrors }) => {
        test.setTimeout(90000);
        const instances: Browser[] = [];
        try {
            for (let index = 0; index < 2; index++) {
                instances.push(await playwright[browserName].launch({ ...launchOptions, headless }));
            }
            const contexts = await Promise.all(instances.map((instance) =>
                instance.newContext({
                    baseURL,
                    ignoreHTTPSErrors,
                    viewport: { width: 390, height: 844 },
                    hasTouch: true
                })
            ));
            for (const [index, context] of contexts.entries()) {
                await context.addInitScript((offsetMs) => {
                    const systemNow = Date.now;
                    Date.now = () => systemNow() + offsetMs;
                }, index === 0 ? hostOffsetMs : -hostOffsetMs);
            }
            const [alice, bob] = await Promise.all(contexts.map((context) => context.newPage()));
            await startTownMatch([alice, bob]);
            const matchId = await alice.locator('#online-game').getAttribute('data-match-id');
            const tick = Number(await bob.locator('#online-game').getAttribute('data-tick'));
            // Continue beyond the eleven-second presence lease, requiring successful renewals.
            await expect.poll(async () => Number(await bob.locator('#online-game').getAttribute('data-tick')), {
                timeout: 20000
            }).toBeGreaterThan(tick + 390);
            await expect(bob.locator('#online-game')).toHaveAttribute('data-match-id', matchId!);
            const x = Number(await bob.locator('#online-game').getAttribute('data-x'));
            await bob.keyboard.down('KeyD');
            await expect.poll(async () => Number(await alice.locator('#online-game').getAttribute('data-peer-x')))
                .toBeGreaterThan(x + 1);
            await bob.keyboard.up('KeyD');
            const disconnectedAt = Date.now();
            await contexts[0].close();
            await expect(bob.locator('#round-status')).toContainText('Waiting for confirmed match state');

            const clock = await bob.locator('#round-clock').textContent();
            const score = await bob.locator('#round-score').textContent();
            await expect(bob.getByRole('heading', { name: 'Round interrupted', exact: true })).toBeVisible({
                timeout: 15000
            });
            expect(Date.now() - disconnectedAt).toBeGreaterThan(13_000);
            await expect(bob.locator('#round-clock')).toHaveText(clock!);
            await expect(bob.locator('#round-score')).toHaveText(score!);
            await bob.getByRole('button', { name: 'Back to solo', exact: true }).click();
            await expect(bob.getByRole('button', { name: 'Play with friends' })).toBeVisible();
        }
        finally {
            await Promise.allSettled(instances.map((instance) => instance.close()));
        }
    });
}

test('survivors with different wall clocks continue the committed round after host loss', async ({ playwright, browserName, launchOptions, headless, baseURL, ignoreHTTPSErrors }) => {
    test.setTimeout(90000);
    const instances: Browser[] = [];
    try {
        for (let index = 0; index < 3; index++) {
            instances.push(await playwright[browserName].launch({ ...launchOptions, headless }));
        }
        const contexts = await Promise.all(instances.map((instance) =>
            instance.newContext({
                baseURL,
                ignoreHTTPSErrors,
                viewport: { width: 390, height: 844 },
                hasTouch: true
            })
        ));
        for (const [index, context] of contexts.entries()) {
            await context.addInitScript((offsetMs) => {
                const systemNow = Date.now;
                Date.now = () => systemNow() + offsetMs;
            }, [2_000, -2_000, 0][index]);
        }
        const [alice, bob, carol] = await Promise.all(contexts.map((context) => context.newPage()));
        await startTownMatch([alice, bob, carol]);
        const matchId = await bob.locator('#online-game').getAttribute('data-match-id');
        const confirmedTick = Math.min(
            ...await Promise.all(
                [bob, carol].map(async (page) => Number(await page.locator('#online-game').getAttribute('data-tick')))
            )
        );
        await contexts[0].close();
        for (const page of [bob, carol]) {
            await expect(page.locator('#round-status')).toContainText('Dash to make trouble', { timeout: 20000 });
            await expect.poll(async () => Number(await page.locator('#online-game').getAttribute('data-tick')), {
                timeout: 20000
            }).toBeGreaterThan(confirmedTick + 60);
            await expect(page.locator('#online-game')).toHaveAttribute('data-match-id', matchId!);
            await expect(page.locator('#round-results')).toBeHidden();
        }
        await expect.poll(async () =>
            (await Promise.all([bob, carol].map((page) => page.locator('#online-game').getAttribute('data-director'))))
                .filter((value) => value === 'true').length
        ).toBe(1);
        const x = Number(await carol.locator('#online-game').getAttribute('data-x'));
        await carol.keyboard.down('KeyD');
        await expect.poll(async () => Number(await bob.locator('#online-game').getAttribute('data-peer-x')))
            .toBeGreaterThan(x + 1);
        await carol.keyboard.up('KeyD');
    }
    finally {
        await Promise.allSettled(instances.map((instance) => instance.close()));
    }
});
