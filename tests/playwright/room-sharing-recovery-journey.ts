import { expect, type Page } from '@playwright/test';

import { signInRoomPlayer, toGroupId } from './room-player-journey.ts';

export async function roomSharingCacheRecoveryJourney(page: Page, game: 'arena' | 'relic'): Promise<void> {
    await signInRoomPlayer(page, 'alice', game);
    await page.getByRole('button', { name: game === 'arena' ? 'New code arena' : 'New code room', exact: true })
        .click();
    const roomLink = page.getByLabel('Room link', { exact: true });
    await expect(roomLink).toHaveValue(/joinCode=/);
    const createdLink = await roomLink.inputValue();
    const applicationId = game === 'arena' ? 'ar-eye-hunter' : 'rallar-server';
    const groupsPath = `/api/state/apps/${applicationId}/workspaces/default/groups`;
    const collection = (url: URL) => url.pathname === groupsPath;
    await page.route(collection, async (route) => {
        if (route.request().method() === 'GET') {
            await route.fulfill({ json: [] });
        }
        else {
            await route.continue();
        }
    });
    try {
        await page.getByRole('button', { name: 'Refresh', exact: true }).click();
        await expect(roomLink).toHaveCount(0);
    }
    finally {
        await page.unroute(collection);
    }
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(roomLink).toHaveValue(createdLink);
    await expect(page.getByRole('button', { name: 'Copy room link', exact: true })).toBeEnabled();
}

export async function roomRotationReturnJourney(page: Page, game: 'arena' | 'relic'): Promise<void> {
    await signInRoomPlayer(page, 'alice', game);
    await page.getByRole('button', { name: game === 'arena' ? 'New unlisted arena' : 'New unlisted room', exact: true })
        .click();
    const link = page.getByLabel('Room link', { exact: true });
    await expect(link).toHaveValue(/#rallar-room\?/);
    const previousRoom = toGroupId(await link.inputValue());
    await page.getByRole('button', { name: game === 'arena' ? 'New code arena' : 'New code room', exact: true })
        .click();
    await expect(link).toHaveValue(/joinCode=/);
    const codeRoom = toGroupId(await link.inputValue());
    const pending = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const rotationPath = `**/groups/${codeRoom}/join-code/rotate/requests/*`;
    await page.route(rotationPath, async (route) => {
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        pending.resolve();
        await release.promise;
        await route.fulfill({ response });
    });
    try {
        await page.getByRole('button', { name: 'Rotate room code', exact: true }).click();
        await pending.promise;
        await page.getByRole('button', { name: `Return to ${previousRoom}`, exact: true }).click();
        await expect(page.getByText(`Entered ${previousRoom}.`, { exact: true })).toBeVisible();
        await page.getByRole('button', { name: `Return to ${codeRoom}`, exact: true }).click();
        await expect(page.getByText(`Entered ${codeRoom}.`, { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Rotate room code', exact: true })).toBeEnabled();
        const delivered = page.waitForResponse(rotationPath);
        release.resolve();
        await delivered;
        await expect(link).toHaveValue('');
        await page.unroute(rotationPath);
        await page.getByRole('button', { name: 'Rotate room code', exact: true }).click();
        await expect(link).toHaveValue(/joinCode=/);
    }
    finally {
        release.resolve();
        await page.unroute(rotationPath);
    }
}
