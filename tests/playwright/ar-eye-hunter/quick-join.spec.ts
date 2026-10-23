import { expect, test, type Page } from '@playwright/test';
import type { GroupSnapshot } from '../../../packages/shared/api/group-types.ts';

test(
    'Quick Join reports unavailable, then joins an arena created by another browser',
    async ({ browser }, testInfo) => {
        test.skip(
            process.env.RALLAR_ARENA_FULL_STACK !== '1',
            'Requires the local API-v1 memory fixture on port 8080.'
        );
        const aliceContext = await browser.newContext();
        const bobContext = await browser.newContext();
        try {
            const alice = await aliceContext.newPage();
            const bob = await bobContext.newPage();
            const bobOperations = await signIn(bob, 'bob');
            await bobOperations.getByRole('button', { name: 'Quick Join', exact: true }).click();
            await expect(bobOperations.getByRole('status')).toHaveText('No available arena. Try again or create one.');
            await expect(bobOperations.getByRole('button', { name: 'New Arena', exact: true })).toBeEnabled();
            await bob.screenshot({ path: testInfo.outputPath('quick-join-unavailable.png'), fullPage: true });

            const aliceOperations = await signIn(alice, 'alice');
            const created = alice.waitForResponse((response) =>
                response.request().method() === 'POST' &&
                /\/groups\/requests\//.test(response.url())
            );
            await aliceOperations.getByRole('button', { name: 'New Arena', exact: true }).click();
            const snapshot: GroupSnapshot = await (await created).json();
            await expect(aliceOperations.locator('.room-row.active')).toContainText(snapshot.group.displayName);

            const admitted = bob.waitForResponse((response) => response.url().includes('/groups/quick-join/requests/'));
            await bobOperations.getByRole('button', { name: 'Quick Join', exact: true }).click();
            const response = await admitted;
            expect(response.status()).toBe(200);
            expect(await response.json()).toMatchObject({
                status: 'joined',
                snapshot: { group: { groupId: snapshot.group.groupId } }
            });
            await expect(bobOperations.getByRole('status')).toHaveText('Joined arena.');
            await expect(bobOperations.locator('.room-row.active')).toContainText(snapshot.group.displayName);
            await bob.screenshot({ path: testInfo.outputPath('quick-join-joined.png'), fullPage: true });
        }
        finally {
            await aliceContext.close();
            await bobContext.close();
        }
    }
);

async function signIn(page: Page, username: string) {
    await page.goto('http://127.0.0.1:5186/');
    await expect(page.getByRole('main')).toBeVisible();
    const open = page.getByRole('button', { name: 'Ops', exact: true });
    if (await open.isVisible()) {
        await open.click();
    }
    const operations = page.getByRole('region', { name: 'Arena operations' });
    await operations.getByLabel('Username', { exact: true }).fill(username);
    await operations.getByLabel('Password', { exact: true }).fill('secret');
    await operations.getByRole('button', { name: 'Enter Arena', exact: true }).click();
    await expect(operations.getByRole('button', { name: 'Quick Join', exact: true })).toBeVisible();
    return operations;
}
