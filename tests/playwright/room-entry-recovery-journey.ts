import { expect, type Page } from '@playwright/test';

import { openArenaOperations, playTogetherInRoom, signInRoomPlayer, toGroupId } from './room-player-journey.ts';

/** A real admission and presence commit followed by a lost response must remain recoverable from visible controls. */
export async function roomEntryRecoveryJourney(host: Page, guest: Page, game: 'arena' | 'relic'): Promise<void> {
    await signInRoomPlayer(host, 'alice', game);
    await signInRoomPlayer(guest, 'bob', game);
    await host.getByRole('button', {
        name: game === 'arena' ? 'New unlisted arena' : 'New unlisted room',
        exact: true
    }).click();
    const link = host.getByLabel('Room link', { exact: true });
    await expect(link).toHaveValue(/#rallar-room\?/);
    const roomId = toGroupId(await link.inputValue());
    const presencePath = new RegExp(`/groups/${roomId}/sessions/[^/]+/requests/`);
    const committedPresenceRequests = new Set<string>();
    await guest.route(presencePath, async (route) => {
        if (route.request().method() !== 'PUT') {
            await route.continue();
            return;
        }
        const response = await route.fetch();
        expect(response.ok(), await response.text()).toBe(true);
        committedPresenceRequests.add(route.request().url());
        await route.abort('connectionreset');
    });
    const admission = guest.waitForResponse((response) => response.url().includes(`/groups/${roomId}/join/requests/`));
    await guest.getByLabel('Room reference', { exact: true }).fill(roomId);
    await guest.getByRole('button', { name: 'Enter room', exact: true }).click();
    expect((await admission).ok()).toBe(true);
    await expect(guest.getByRole('alert')).toContainText('Room admission succeeded, but finishing entry failed.');
    expect(committedPresenceRequests.size).toBe(1);
    await expect(guest.getByRole('button', { name: 'Retry room entry', exact: true })).toBeEnabled();
    await guest.unroute(presencePath);
    await guest.getByRole('button', { name: 'Retry room entry', exact: true }).click();
    await expect(guest.getByText(`Entered ${roomId}.`, { exact: true })).toBeVisible();
    for (const page of [host, guest]) {
        await expect(page.getByRole('region', { name: `Members of ${roomId}`, exact: true })).toContainText(
            '2 present'
        );
    }
    await guest.reload();
    if (game === 'arena') {
        await openArenaOperations(guest);
    }
    await expect(guest.getByText(`Entered ${roomId}.`, { exact: true })).toBeVisible();
    await playTogetherInRoom(host, guest, game);
}
