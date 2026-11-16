import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

import { registerPlayer, startTownMatch } from './match-browser.ts';

interface InputPresentationTiming {
    readonly renderedMs: number;
    readonly confirmedMs: number;
}

test('only eligible players can host and a resolved appointment failure leaves the lobby', async ({ browser }) => {
    test.setTimeout(60000);
    const ownerContext = await browser.newContext();
    const guestContext = await browser.newContext();
    const owner = await ownerContext.newPage();
    const guest = await guestContext.newPage();
    try {
        await registerPlayer(owner, `host-controls-owner-${Date.now()}`);
        await registerPlayer(guest, `host-controls-guest-${Date.now()}`);
        await owner.getByRole('button', { name: 'Create town', exact: true }).click();
        await guest.getByLabel('Town code').fill(await owner.getByLabel('Room code').inputValue());
        await guest.getByRole('button', { name: 'Join town', exact: true }).click();
        await expect(guest.getByRole('button', { name: 'Host match', exact: true })).toBeDisabled();
        await expect(guest.locator('#match-controls')).toContainText('owner/admin');
        await owner.route('**/director/appoint/requests/*', (route) => route.abort());
        await owner.getByRole('button', { name: 'Host match', exact: true }).click();
        await expect(owner.locator('#match-controls')).toContainText(/failed|fetch|network/i);
        await owner.unroute('**/director/appoint/requests/*');
        await owner.getByRole('button', { name: 'Host match', exact: true }).click();
        await expect(owner.getByRole('button', { name: 'Ready', exact: true })).toBeEnabled({ timeout: 15000 });
        await expect(guest.getByRole('button', { name: 'Ready', exact: true })).toBeEnabled({ timeout: 15000 });
        await expect(owner.locator('#match-controls')).toContainText('You direct this match');
        await expect(guest.locator('#match-controls')).toContainText('Player-hosted match');
        await expect(owner.locator('#match-controls')).not.toContainText(/failed|fetch|network/i);
    }
    finally {
        await Promise.allSettled([ownerContext.close(), guestContext.close()]);
    }
});

test('host and guest show local input before confirmed movement', async ({ browser }) => {
    test.setTimeout(60000);
    const contexts = await Promise.all([browser.newContext({ hasTouch: true }), browser.newContext({ hasTouch: true })]);
    const pages = await Promise.all(contexts.map((context) => context.newPage()));
    const measurements: { player: number; action: string; renderedMs: number; confirmedMs: number; }[] = [];
    try {
        await startTownMatch(pages);
        for (const [player, page] of pages.entries()) {
            const movement = measureInputPresentation(page, 'movement');
            await expect(page.locator('#online-game')).toHaveAttribute('data-measure-armed', 'movement');
            await page.keyboard.down('KeyD');
            const moved = await movement;
            await page.keyboard.up('KeyD');
            measurements.push({ player, action: 'movement', ...moved });
            expect(moved.renderedMs).toBeLessThan(moved.confirmedMs);
            const dash = measureInputPresentation(page, 'dash');
            await expect(page.locator('#online-game')).toHaveAttribute('data-measure-armed', 'dash');
            await page.getByRole('button', { name: 'Dash and drop', exact: true }).tap();
            const dashed = await dash;
            measurements.push({ player, action: 'dash', ...dashed });
            expect(dashed.renderedMs).toBeLessThan(dashed.confirmedMs);
            await expect(page.locator('#online-game')).toHaveAttribute('data-dashes', '1');
            await page.screenshot({ path: test.info().outputPath(`responsive-player-${player}.png`) });
        }
    }
    finally {
        await writeFile(test.info().outputPath('input-presentation.json'), JSON.stringify(measurements, null, 2));
        await Promise.allSettled(contexts.map((context) => context.close()));
    }
});

test('a returning owner replaces a guest appointment failure with healthy lobby status', async ({ browser }) => {
    test.setTimeout(60000);
    const ownerContext = await browser.newContext();
    const guestContext = await browser.newContext();
    const owner = await ownerContext.newPage();
    const guest = await guestContext.newPage();
    try {
        await registerPlayer(owner, `returning-owner-${Date.now()}`);
        await registerPlayer(guest, `waiting-guest-${Date.now()}`);
        await owner.getByRole('button', { name: 'Create town', exact: true }).click();
        const roomCode = await owner.getByLabel('Room code').inputValue();
        await guest.getByLabel('Town code').fill(roomCode);
        await guest.getByRole('button', { name: 'Join town', exact: true }).click();
        await expect(guest.getByRole('button', { name: 'Host match', exact: true })).toBeDisabled();
        await owner.close();
        await expect(guest.getByRole('button', { name: 'Host match', exact: true })).toBeEnabled({ timeout: 15000 });
        await guest.route('**/director/appoint/requests/*', (route) => route.abort());
        await guest.getByRole('button', { name: 'Host match', exact: true }).click();
        await expect(guest.locator('#match-controls')).toContainText(/failed|fetch|network/i);
        const returned = await ownerContext.newPage();
        await returned.goto('/');
        await returned.getByRole('button', { name: 'Play with friends', exact: true }).click();
        await returned.getByLabel('Town code').fill(roomCode);
        await returned.getByRole('button', { name: 'Join town', exact: true }).click();
        await returned.getByRole('button', { name: 'Host match', exact: true }).click();
        await expect(guest.getByRole('button', { name: 'Ready', exact: true })).toBeEnabled({ timeout: 15000 });
        await expect(guest.locator('#match-controls')).toContainText('Player-hosted match');
        await expect(guest.locator('#match-controls')).not.toContainText(/failed|fetch|network/i);
    }
    finally {
        await Promise.allSettled([ownerContext.close(), guestContext.close()]);
    }
});

async function measureInputPresentation(page: Page, action: 'movement' | 'dash'): Promise<InputPresentationTiming> {
    return page.evaluate((action) => new Promise<InputPresentationTiming>((resolve, reject) => {
        const root = document.querySelector<HTMLElement>('#online-game')!;
        const rendered = action === 'movement' ? 'renderX' : 'renderDashes';
        const confirmed = action === 'movement' ? 'x' : 'dashes';
        const target = action === 'movement' ? window : root.querySelector('#dash')!;
        const event = action === 'movement' ? 'keydown' : 'pointerdown';
        target.addEventListener(event, () => {
            const started = performance.now();
            const beforeRendered = Number(root.dataset[rendered]);
            const beforeConfirmed = Number(root.dataset[confirmed]);
            let renderedMs: number | undefined;
            let confirmedMs: number | undefined;
            const observe = (): void => {
                const elapsed = performance.now() - started;
                if (Math.abs(Number(root.dataset[rendered]) - beforeRendered) > 0.00001) {
                    renderedMs ??= elapsed;
                }
                if (Math.abs(Number(root.dataset[confirmed]) - beforeConfirmed) > 0.00001) {
                    confirmedMs ??= elapsed;
                }
                if (renderedMs !== undefined && confirmedMs !== undefined) {
                    resolve({ renderedMs, confirmedMs });
                }
                else if (elapsed > 3000) {
                    reject(new Error(`No ${action} confirmation within three seconds`));
                }
                else {
                    requestAnimationFrame(observe);
                }
            };
            requestAnimationFrame(observe);
        }, { once: true, capture: true });
        root.dataset.measureArmed = action;
    }), action);
}
