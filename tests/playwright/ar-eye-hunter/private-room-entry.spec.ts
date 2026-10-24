import {
    expect,
    test,
    type Page
} from '@playwright/test';

import { roomBrowserTest } from '../room-browser-fixture.ts';

test('keeps manual private-room entry through signed-out reload and allows cancellation', async ({ page }) => {
    const operations = await openOperations(page, '/');
    await operations.getByLabel('Room reference', { exact: true }).fill('friends-arena');
    await operations.getByLabel('Room code', { exact: true }).fill('friends-code');
    await operations.getByRole('button', { name: 'Enter room', exact: true }).click();

    await expect(operations.getByText('Sign in to enter friends-arena.', { exact: true })).toBeVisible();
    await page.reload();
    await openOperationsPanel(page);
    await expect(operations.getByText('Sign in to enter friends-arena.', { exact: true })).toBeVisible();
    await operations.getByRole('button', { name: 'Cancel room entry', exact: true }).click();

    await expect(operations.getByText('Sign in to enter friends-arena.', { exact: true })).toHaveCount(0);
    await page.reload();
    await openOperationsPanel(page);
    await expect(operations.getByText('Sign in to enter friends-arena.', { exact: true })).toHaveCount(0);
});

test('shows a wrong-scope invitation without sending an admission request', async ({ page }) => {
    const admissions: string[] = [];
    page.on('request', (request) => {
        if (request.method() === 'POST' && request.url().includes('/join/requests/')) {
            admissions.push(request.url());
        }
    });
    const operations = await openOperations(
        page,
        '/#rallar-room?applicationId=other-app&workspaceId=default&groupId=friends-arena'
    );

    await expect(operations.getByText('This room belongs to a different application or workspace.', { exact: true }))
        .toBeVisible();
    expect(admissions).toEqual([]);
    await operations.getByRole('button', { name: 'Cancel room entry', exact: true }).click();
    await expect(operations.getByText('This room belongs to a different application or workspace.', { exact: true }))
        .toHaveCount(0);
});

roomBrowserTest(
    'shares a code arena through sign-in, participation, rotation, and member reload',
    async ({ page: host, guest }, testInfo) => {
        roomBrowserTest.skip(
            process.env.RALLAR_ARENA_FULL_STACK !== '1',
            'Requires the local API-v1 memory fixture on port 8080.'
        );
        const hostOperations = await openOperations(host, '/');
        await signIn(host, 'alice');
        const create = hostOperations.getByRole('button', { name: 'New code arena', exact: true });
        await expect(create).toBeVisible();
        await create.click();
        const linkField = hostOperations.getByLabel('Room link', { exact: true });
        await expect(linkField).toHaveValue(/#rallar-room\?.*joinCode=/);
        const originalLink = await linkField.inputValue();
        const reference = new URLSearchParams(new URL(originalLink).hash.slice('#rallar-room?'.length)).get(
            'groupId'
        );
        expect(reference).toBeTruthy();
        const guestOperations = await openOperations(guest, originalLink);
        await expect(guestOperations.getByText(`Sign in to enter ${reference}.`, { exact: true })).toBeVisible();
        await signIn(guest, 'bob');
        await expect(guestOperations.getByText(`Entered ${reference}.`, { exact: true })).toBeVisible();

        const appoint = hostOperations.getByRole('button', { name: 'Appoint this SPA', exact: true });
        if (await appoint.isEnabled()) {
            await appoint.click();
        }
        await expect(hostOperations.getByRole('button', { name: '1m', exact: true })).toBeEnabled({
            timeout: 20_000
        });
        await hostOperations.getByRole('button', { name: '1m', exact: true }).click();
        await expect(guestOperations.locator('.match-panel strong')).toHaveText(/^[01]:\d{2}$/, {
            timeout: 20_000
        });
        await guest.screenshot({ path: testInfo.outputPath('private-arena-participating.png'), fullPage: true });
        await hostOperations.getByRole('button', { name: 'Rotate room code', exact: true }).click();
        await expect(linkField).toHaveValue(/#rallar-room\?.*joinCode=/);
        await expect(linkField).not.toHaveValue(originalLink);
        await guest.reload();
        await openOperationsPanel(guest);
        await expect(guestOperations.getByText(`Entered ${reference}.`, { exact: true })).toBeVisible();
    }
);

roomBrowserTest(
    'requires an account invitation, honors revocation, and accepts a reissued invitation',
    async ({ page: host, guest }, testInfo) => {
        roomBrowserTest.skip(
            process.env.RALLAR_ARENA_FULL_STACK !== '1',
            'Requires the local API-v1 memory fixture on port 8080.'
        );
        const hostOperations = await openOperations(host, '/');
        await signIn(host, 'alice');
        await openOperations(guest, '/');
        await signIn(guest, 'bob');
        const guestAccountReference = await guest.getByLabel('Account reference', { exact: true }).inputValue();
        await hostOperations.getByRole('button', { name: 'New invite-only arena', exact: true }).click();
        const linkField = hostOperations.getByLabel('Room link', { exact: true });
        await expect(linkField).toHaveValue(/#rallar-room\?/);
        const link = await linkField.inputValue();
        expect(link).not.toContain('joinCode=');
        const reference = new URLSearchParams(new URL(link).hash.slice('#rallar-room?'.length)).get('groupId');
        const guestOperations = await openOperations(guest, link);
        await expect(guestOperations.getByRole('alert')).toContainText('Room entry was denied.');
        await hostOperations.getByLabel('Invite account reference', { exact: true }).fill(guestAccountReference);
        await hostOperations.getByRole('button', { name: 'Invite account', exact: true }).click();
        await hostOperations.getByRole('button', { name: 'Revoke invitation', exact: true }).click();
        await expect(hostOperations.getByRole('button', { name: 'Revoke invitation', exact: true })).toHaveCount(0);
        await guestOperations.getByRole('button', { name: 'Retry room entry', exact: true }).click();
        await expect(guestOperations.getByRole('alert')).toContainText('Room entry was denied.');
        await hostOperations.getByRole('button', { name: 'Invite account', exact: true }).click();
        await expect(hostOperations.getByRole('button', { name: 'Revoke invitation', exact: true })).toHaveCount(1);
        await guestOperations.getByRole('button', { name: 'Retry room entry', exact: true }).click();
        await expect(guestOperations.getByText(`Entered ${reference}.`, { exact: true })).toBeVisible();
        await guest.screenshot({ path: testInfo.outputPath('private-arena-invited.png'), fullPage: true });
    }
);

roomBrowserTest(
    'rejects a rotated code after registration, accepts correction, and prioritizes a new invitation',
    async ({ page: host, guest }) => {
        roomBrowserTest.skip(
            process.env.RALLAR_ARENA_FULL_STACK !== '1',
            'Requires the local API-v1 memory fixture on port 8080.'
        );
        const hostOperations = await openOperations(host, '/');
        await signIn(host, 'alice');
        await hostOperations.getByRole('button', { name: 'New code arena', exact: true }).click();
        const linkField = hostOperations.getByLabel('Room link', { exact: true });
        await expect(linkField).toHaveValue(/#rallar-room\?.*joinCode=/);
        const oldLink = await linkField.inputValue();
        await hostOperations.getByRole('button', { name: 'Rotate room code', exact: true }).click();
        await expect(linkField).toHaveValue(/#rallar-room\?.*joinCode=/);
        await expect(linkField).not.toHaveValue(oldLink);
        const currentLink = await linkField.inputValue();
        const fields = new URLSearchParams(new URL(currentLink).hash.slice('#rallar-room?'.length));
        const reference = fields.get('groupId');
        const code = fields.get('joinCode');
        if (!reference || !code) {
            throw new Error('The generated private-room link must contain its reference and code.');
        }
        const guestOperations = await openOperations(guest, oldLink);
        await guestOperations.getByRole('button', { name: 'Register', exact: true }).click();
        await guestOperations.getByLabel('Username', { exact: true }).fill(`guest-${crypto.randomUUID().slice(0, 8)}`);
        await guestOperations.getByLabel('Password', { exact: true }).fill('private-room-test-password');
        await guestOperations.getByRole('button', { name: 'Create Hunter', exact: true }).click();
        await expect(guestOperations.getByRole('alert')).toContainText('Room entry was denied.');
        await guestOperations.getByLabel('Room reference', { exact: true }).fill(reference);
        await guestOperations.getByLabel('Room code', { exact: true }).fill(code);
        await guestOperations.getByRole('button', { name: 'Enter room', exact: true }).click();
        await expect(guestOperations.getByText(`Entered ${reference}.`, { exact: true })).toBeVisible();
        await hostOperations.getByRole('button', { name: 'New code arena', exact: true }).click();
        await expect(linkField).not.toHaveValue(currentLink);
        // Creating while connected also settles the previous room before rotating the new code.
        await expect(linkField).toHaveValue(/#rallar-room\?.*joinCode=/, { timeout: 30_000 });
        const nextLink = await linkField.inputValue();
        const nextReference = new URLSearchParams(new URL(nextLink).hash.slice('#rallar-room?'.length)).get('groupId');
        await openOperations(guest, nextLink);
        await expect(guestOperations.getByText(`Entered ${nextReference}.`, { exact: true })).toBeVisible();
        await expect(guestOperations.getByText(`Entered ${reference}.`, { exact: true })).toHaveCount(0);
        await expect(guest).not.toHaveURL(/joinCode=/);
    }
);

roomBrowserTest(
    'shares an unlisted arena, retries listing, and keeps its guest through hiding',
    async ({ page: host, guest }, testInfo) => {
        roomBrowserTest.skip(process.env.RALLAR_ARENA_FULL_STACK !== '1', 'Requires the local API-v1 memory fixture.');
        const hostOperations = await openOperations(host, '/');
        await signIn(host, 'alice');
        await expect(hostOperations.getByRole('button', { name: 'New unlisted arena', exact: true })).toBeVisible();
        await hostOperations.getByRole('button', { name: 'New unlisted arena', exact: true }).click();
        await expect(hostOperations.getByRole('button', { name: 'List room', exact: true })).toBeEnabled();
        const link = await hostOperations.getByLabel('Room link', { exact: true }).inputValue();
        expect(link).toContain('#rallar-room?');
        expect(link).not.toContain('joinCode=');
        const reference = new URLSearchParams(new URL(link).hash.slice('#rallar-room?'.length)).get('groupId');
        const roomName = await hostOperations.locator('.room-row.active span').innerText();
        const guestOperations = await openOperations(guest, '/');
        await signIn(guest, 'bob');
        await guestOperations.getByRole('button', { name: 'Refresh', exact: true }).click();
        await expect(guestOperations.locator('.room-row').filter({ hasText: roomName })).toHaveCount(0);
        await host.route('**/groups/*/requests/*', async (route) => {
            if (route.request().method() === 'PUT' && route.request().postDataJSON().directoryListing) {
                await route.fulfill({ status: 403, json: { error: 'Listing unavailable' } });
            }
            else {
                await route.continue();
            }
        });
        await hostOperations.getByRole('button', { name: 'List room', exact: true }).click();
        await expect(hostOperations.getByRole('alert')).toContainText('Could not change room listing');
        await expect(hostOperations.getByRole('button', { name: 'List room', exact: true })).toBeEnabled();
        await host.unroute('**/groups/*/requests/*');
        await hostOperations.getByRole('button', { name: 'List room', exact: true }).click();
        await expect(hostOperations.getByRole('button', { name: 'Unlist room', exact: true })).toBeEnabled();
        await guestOperations.getByRole('button', { name: 'Refresh', exact: true }).click();
        await expect(guestOperations.locator('.room-row').filter({ hasText: roomName })).toHaveCount(1);
        await hostOperations.getByRole('button', { name: 'Unlist room', exact: true }).click();
        await expect(hostOperations.getByRole('button', { name: 'List room', exact: true })).toBeEnabled();
        await guestOperations.getByRole('button', { name: 'Refresh', exact: true }).click();
        await expect(guestOperations.locator('.room-row').filter({ hasText: roomName })).toHaveCount(0);
        await openOperations(guest, link);
        await expect(guestOperations.getByText(`Entered ${reference}.`, { exact: true })).toBeVisible();
        await hostOperations.getByRole('button', { name: 'List room', exact: true }).click();
        await hostOperations.getByRole('button', { name: 'Unlist room', exact: true }).click();
        await expect(guestOperations.locator('.room-row.active span')).toHaveText(roomName);
        const appoint = hostOperations.getByRole('button', { name: 'Appoint this SPA', exact: true });
        if (await appoint.isEnabled()) {
            await appoint.click();
        }
        await expect(hostOperations.getByRole('button', { name: '1m', exact: true })).toBeEnabled({ timeout: 20_000 });
        await hostOperations.getByRole('button', { name: '1m', exact: true }).click();
        await expect(guestOperations.locator('.match-panel strong')).toHaveText(/^[01]:\d{2}$/, { timeout: 20_000 });
        await guest.screenshot({ path: testInfo.outputPath('unlisted-arena-participating.png'), fullPage: true });
    }
);

roomBrowserTest(
    'recovers recent arenas after reload and forgets shortcuts without leaving',
    async ({ page: host, guest }, testInfo) => {
        // Two browsers, fresh invitations, denial/retry, and two reloads share this journey budget.
        roomBrowserTest.setTimeout(180_000);
        roomBrowserTest.skip(process.env.RALLAR_ARENA_FULL_STACK !== '1', 'Requires the local API-v1 memory fixture.');
        const hostOperations = await openOperations(host, '/');
        await signIn(host, 'alice');
        await hostOperations.getByRole('button', { name: 'New unlisted arena', exact: true }).click();
        const linkField = hostOperations.getByLabel('Room link', { exact: true });
        await expect(linkField).toHaveValue(/#rallar-room\?/);
        const firstLink = await linkField.inputValue();
        const firstRef = new URLSearchParams(new URL(firstLink).hash.slice('#rallar-room?'.length)).get('groupId');
        if (!firstRef) {
            throw new Error('The first arena must have a scoped share reference.');
        }
        const guestOperations = await openOperations(guest, firstLink);
        await signIn(guest, 'bob');
        const history = guestOperations.getByRole('region', { name: 'Recent rooms', exact: true });
        await expect(history.getByRole('button', { name: `Return to ${firstRef}`, exact: true })).toBeVisible();
        await hostOperations.getByRole('button', { name: 'New code arena', exact: true }).click();
        await expect(linkField).not.toHaveValue(firstLink);
        await expect(linkField).toHaveValue(/joinCode=/, { timeout: 30_000 });
        const secondLink = await linkField.inputValue();
        const secondRef = new URLSearchParams(new URL(secondLink).hash.slice('#rallar-room?'.length)).get('groupId');
        if (!secondRef) {
            throw new Error('The second arena must have a scoped share reference.');
        }
        await openOperations(guest, secondLink);
        await expect(guestOperations.getByText(`Entered ${secondRef}.`, { exact: true })).toBeVisible();
        await expect(history.getByRole('button', { name: `Return to ${firstRef}`, exact: true })).toBeVisible();
        await host.goto('about:blank');
        await guest.reload();
        await openOperationsPanel(guest);
        await expect(guestOperations.getByText(`Entered ${secondRef}.`, { exact: true })).toBeVisible();
        const admissionPath = `**/groups/${firstRef}/join/requests/*`;
        await guest.route(
            admissionPath,
            (route) => route.fulfill({ status: 403, json: { error: 'Room no longer available' } })
        );
        await history.getByRole('button', { name: `Return to ${firstRef}`, exact: true }).click();
        await expect(guestOperations.getByRole('alert')).toContainText('Room entry was denied');
        await guest.unroute(admissionPath);
        await history.getByRole('button', { name: `Return to ${firstRef}`, exact: true }).click();
        await expect(guestOperations.getByText(`Entered ${firstRef}.`, { exact: true })).toBeVisible();
        await expect(guestOperations.getByLabel('Room code', { exact: true })).toHaveValue('');
        await history.getByRole('button', { name: `Forget ${secondRef}`, exact: true }).click();
        await expect(history.getByRole('button', { name: `Return to ${secondRef}`, exact: true })).toHaveCount(0);
        await expect(guestOperations.getByText(`Entered ${firstRef}.`, { exact: true })).toBeVisible();
        await guest.reload();
        await openOperationsPanel(guest);
        await expect(history.getByRole('button', { name: `Return to ${firstRef}`, exact: true })).toBeVisible();
        await expect(history.getByRole('button', { name: `Return to ${secondRef}`, exact: true })).toHaveCount(0);
        await guest.screenshot({ path: testInfo.outputPath('recent-arena-recovery.png'), fullPage: true });
    }
);

test(
    'creates a temporary arena with ten-minute reconnect grace from the visible control',
    async ({ page }, testInfo) => {
        test.skip(process.env.RALLAR_ARENA_FULL_STACK !== '1', 'Requires the local API-v1 memory fixture.');
        const operations = await openOperations(page, '/');
        await signIn(page, 'alice');
        const created = page.waitForResponse((response) =>
            response.request().method() === 'POST' && /\/groups\/(?:[^/]+\/)?requests\//.test(response.url())
        );
        await operations.getByRole('button', { name: 'New Arena', exact: true }).click();
        const response = await created;
        expect(response.ok()).toBe(true);
        expect(response.request().postDataJSON().retention).toEqual({ mode: 'temporary', reconnectGraceMs: 600_000 });
        expect((await response.json()).group.metadata.rallarRetention).toEqual({
            mode: 'temporary',
            reconnectGraceMs: 600_000,
            emptyPresenceFingerprint: null
        });
        await expect(operations.getByLabel('Room link', { exact: true })).toHaveValue(/#rallar-room\?/);
        await page.screenshot({ path: testInfo.outputPath('temporary-arena-created.png'), fullPage: true });
    }
);

async function signIn(page: Page, username: string): Promise<void> {
    const operations = page.getByRole('region', { name: 'Arena operations' });
    await operations.getByLabel('Username', { exact: true }).fill(username);
    await operations.getByLabel('Password', { exact: true }).fill('secret');
    await operations.getByRole('button', { name: 'Enter Arena', exact: true }).click();
    await expect(operations.getByRole('button', { name: 'New Arena', exact: true })).toBeVisible();
}

async function openOperations(page: Page, url: string) {
    await page.goto(url);
    await expect(page.getByRole('main')).toBeVisible();
    await openOperationsPanel(page);
    return page.getByRole('region', { name: 'Arena operations' });
}

async function openOperationsPanel(page: Page): Promise<void> {
    const button = page.getByRole('button', { name: 'Ops', exact: true });
    if (await button.isVisible()) {
        await button.click();
    }
}
