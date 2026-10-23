import {
    expect,
    test,
    type Page
} from '@playwright/test';

import { arenaRoomTest } from './arena-room-fixture.ts';

test('keeps manual private-room entry through signed-out reload and allows cancellation', async ({ page }) => {
    const operations = await openOperations(page, '/');
    await operations.getByLabel('Room reference', { exact: true }).fill('friends-arena');
    await operations.getByLabel('Room code', { exact: true }).fill('friends-code');
    await operations.getByRole('button', { name: 'Enter private room', exact: true }).click();

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

arenaRoomTest(
    'shares a code arena through sign-in, participation, rotation, and member reload',
    async ({ page: host, guest }, testInfo) => {
        test.skip(
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

arenaRoomTest(
    'requires an account invitation, honors revocation, and accepts a reissued invitation',
    async ({ page: host, guest }, testInfo) => {
        test.skip(
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

arenaRoomTest(
    'rejects a rotated code after registration, accepts correction, and prioritizes a new invitation',
    async ({ page: host, guest }) => {
        test.skip(
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
        await guestOperations.getByRole('button', { name: 'Enter private room', exact: true }).click();
        await expect(guestOperations.getByText(`Entered ${reference}.`, { exact: true })).toBeVisible();
        await hostOperations.getByRole('button', { name: 'New code arena', exact: true }).click();
        await expect(linkField).toHaveValue(/#rallar-room\?.*joinCode=/);
        await expect(linkField).not.toHaveValue(currentLink);
        const nextLink = await linkField.inputValue();
        const nextReference = new URLSearchParams(new URL(nextLink).hash.slice('#rallar-room?'.length)).get('groupId');
        await openOperations(guest, nextLink);
        await expect(guestOperations.getByText(`Entered ${nextReference}.`, { exact: true })).toBeVisible();
        await expect(guestOperations.getByText(`Entered ${reference}.`, { exact: true })).toHaveCount(0);
        await expect(guest).not.toHaveURL(/joinCode=/);
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
