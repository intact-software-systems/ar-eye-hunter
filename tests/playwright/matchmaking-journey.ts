import { expect, type Page } from '@playwright/test';
import { openArenaOperations, playTogetherInRoom, signInRoomPlayer, toGroupId } from './room-player-journey.ts';

/** The API owns reservations; both browsers reach it only through visible game controls. */
export async function matchmakingPlayJourney(host: Page, guest: Page, game: 'arena' | 'relic'): Promise<void> {
    await signInRoomPlayer(host, 'alice', game);
    await signInRoomPlayer(guest, 'bob', game);
    const hostPanel = panel(host);
    const guestPanel = panel(guest);
    await expect(hostPanel).toBeVisible();
    await expect(guestPanel).toBeVisible();
    await hostPanel.getByRole('button', { name: /Find a game|Find an expedition/ }).click();
    await expect(hostPanel).toContainText('Searching for players');
    await host.reload();
    if (game === 'arena') {
        await openArenaOperations(host);
    }
    await expect(hostPanel).toContainText('Searching for players');
    await hostPanel.getByRole('button', { name: 'Cancel search', exact: true }).click();
    await expect(hostPanel).toContainText('Search cancelled');
    await hostPanel.getByRole('button', { name: /Find a game|Find an expedition/ }).click();
    await expect(hostPanel).toContainText('Searching for players');
    await guestPanel.getByRole('button', { name: /Find a game|Find an expedition/ }).click();
    await expect(hostPanel).toContainText('Players found');
    await expect(guestPanel).toContainText('Players found');
    await guestPanel.getByRole('button', { name: 'Decline match', exact: true }).click();
    await expect(hostPanel).toContainText('A player declined');
    await expect(guestPanel).toContainText('A player declined');
    await confirmMatch(host, guest, game);
    await guestPanel.getByRole('button', { name: 'Enter matched room', exact: true }).click();
    await hostPanel.getByRole('button', { name: 'Enter matched room', exact: true }).click();
    const hostLink = host.getByLabel('Room link', { exact: true });
    await expect(hostLink).toHaveValue(/#rallar-room\?/);
    const roomId = toGroupId(await hostLink.inputValue());
    await expect(host.getByText(`Entered ${roomId}.`, { exact: true })).toBeVisible({ timeout: 30000 });
    await expect(guest.getByText(`Entered ${roomId}.`, { exact: true })).toBeVisible({ timeout: 30000 });
    await playTogetherInRoom(host, guest, game);
}

async function confirmMatch(host: Page, guest: Page, game: 'arena' | 'relic'): Promise<void> {
    await panel(host).getByRole('button', { name: /Find a game|Find an expedition/ }).click();
    await expect(panel(host)).toContainText('Searching for players');
    await panel(guest).getByRole('button', { name: /Find a game|Find an expedition/ }).click();
    await expect(panel(host)).toContainText('Players found');
    await host.reload();
    if (game === 'arena') {
        await openArenaOperations(host);
    }
    await expect(panel(host)).toContainText('Players found');
    await panel(host).getByRole('button', { name: 'Confirm match', exact: true }).click();
    await expect(panel(host)).toContainText('Waiting for the other players');
    await expect(panel(guest).getByRole('button', { name: 'Enter matched room', exact: true })).toHaveCount(0);
    await panel(guest).getByRole('button', { name: 'Confirm match', exact: true }).click();
    await expect(panel(host)).toContainText('Your group is ready');
    await expect(panel(guest)).toContainText('Your group is ready');
}

function panel(page: Page) {
    return page.getByRole('region', { name: 'Find players', exact: true });
}

export async function matchmakingExpiryJourney(host: Page, guest: Page, game: 'arena' | 'relic'): Promise<void> {
    await signInRoomPlayer(host, 'alice', game);
    await signInRoomPlayer(guest, 'bob', game);
    const hostPanel = panel(host);
    const guestPanel = panel(guest);
    const find = hostPanel.getByRole('button', { name: /Find a game|Find an expedition/ });
    await expect(find).toBeEnabled();
    const requests: string[] = [];
    const endpoint = '**/api/matchmaking/apps/*/workspaces/*/requests/*';
    await host.route(endpoint, async (route) => {
        requests.push(route.request().url());
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        await route.abort('failed');
    });
    await find.click();
    await expect(hostPanel.getByRole('button', { name: 'Retry matchmaking request', exact: true })).toBeEnabled({
        timeout: 40000
    });
    await host.unroute(endpoint);
    expect(requests.length).toBeGreaterThan(0);
    expect(new Set(requests).size).toBe(1);
    await hostPanel.getByRole('button', { name: 'Retry matchmaking request', exact: true }).click();
    await expect(hostPanel).toContainText('Searching for players');
    await expect(hostPanel.getByRole('button', { name: 'Retry matchmaking request', exact: true })).toHaveCount(0);
    await expect(hostPanel).toContainText('No group was found before the search ended.', { timeout: 150000 });
    await expect(find).toBeEnabled();
    await find.click();
    await expect(hostPanel).toContainText('Searching for players');
    await guestPanel.getByRole('button', { name: /Find a game|Find an expedition/ }).click();
    await hostPanel.getByRole('button', { name: 'Confirm match', exact: true }).click();
    await expect(hostPanel).toContainText('Waiting for the other players');
    await expect(hostPanel).toContainText('Confirmation timed out.', { timeout: 45000 });
    await expect(guestPanel).toContainText('Confirmation timed out.');
    await expect(guestPanel.getByRole('button', { name: 'Enter matched room', exact: true })).toHaveCount(0);
    await find.click();
    await expect(hostPanel).toContainText('Searching for players');
    await hostPanel.getByRole('button', { name: 'Cancel search', exact: true }).click();
    await expect(hostPanel).toContainText('Search cancelled.');
}
