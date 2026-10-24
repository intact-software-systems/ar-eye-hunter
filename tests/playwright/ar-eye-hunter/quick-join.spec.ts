import {
    expect,
    type Page
} from '@playwright/test';

import type { GroupSnapshot } from '../../../packages/shared/api/group-types.ts';

import { roomBrowserTest } from '../room-browser-fixture.ts';

roomBrowserTest(
    'Quick Join recovers from an unavailable API and enters a shared match',
    async ({ page: alice, guest: bob }, testInfo) => {
        roomBrowserTest.skip(
            process.env.RALLAR_ARENA_FULL_STACK !== '1',
            'Requires the local API-v1 memory fixture on port 8080.'
        );
        const bobOperations = await signIn(bob, 'bob');
        await bob.route(
            '**/groups/quick-join/requests/*',
            (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: '404 Not Found' })
        );
        await bobOperations.getByRole('button', { name: 'Quick Join', exact: true }).click();
        await expect(bobOperations.getByRole('status')).toContainText('404 Not Found');
        await expect(bobOperations.getByRole('button', { name: 'Quick Join', exact: true })).toBeEnabled();
        await expect(bobOperations.locator('.room-row.active')).toHaveCount(0);
        await bob.unroute('**/groups/quick-join/requests/*');
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
        // A human can start another arena while still owning the previous one. That cleanup
        // denial must not prevent the host or a Quick Joining guest from entering the new match.
        const replacementCreated = alice.waitForResponse((candidate) =>
            candidate.request().method() === 'POST' && /\/groups\/requests\//.test(candidate.url())
        );
        await aliceOperations.getByRole('button', { name: 'New Arena', exact: true }).click();
        const replacement: GroupSnapshot = await (await replacementCreated).json();
        expect(replacement.group.groupId).not.toBe(snapshot.group.groupId);
        await expect(aliceOperations.locator('.room-row.active')).toContainText(replacement.group.displayName);
        await expect(aliceOperations.getByText(
            'The new arena is ready, but leaving the previous arena failed. Your membership there remains.',
            { exact: true }
        )).toBeVisible();
        await bobOperations.getByRole('button', { name: 'Quick Join', exact: true }).click();
        await expect(bobOperations.getByRole('status')).toHaveText('Joined arena.');
        await expect(bobOperations.locator('.room-row.active')).toContainText(replacement.group.displayName);
        const appoint = aliceOperations.getByRole('button', { name: 'Appoint this SPA', exact: true });
        if (await appoint.isEnabled()) {
            await appoint.click();
        }
        await expect(aliceOperations.getByRole('button', { name: '1m', exact: true })).toBeEnabled({ timeout: 20_000 });
        await expect(bobOperations.locator('.match-panel strong')).toHaveText('infinite');
        await aliceOperations.getByRole('button', { name: '1m', exact: true }).click();
        await expect(aliceOperations.locator('.match-panel strong')).toHaveText(/^(1:00|0:[0-5]\d)$/, {
            timeout: 20_000
        });
        await expect(bobOperations.locator('.match-panel strong')).toHaveText(/^(1:00|0:[0-5]\d)$/, {
            timeout: 20_000
        });
        await expect(bobOperations.getByRole('status')).toHaveText('Joined arena.');
        await bob.screenshot({ path: testInfo.outputPath('quick-join-playing.png'), fullPage: true });
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
