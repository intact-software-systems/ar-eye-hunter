import { expect, type Page } from '@playwright/test';
import { openArenaOperations, playTogetherInRoom, signInRoomPlayer, toGroupId } from './room-player-journey.ts';
import { scheduleThroughControls } from './scheduled-session-journey.ts';

/** Two independent accounts, visible controls, real API and actual shared gameplay. */
export async function friendsPlayJourney(host: Page, guest: Page, game: 'arena' | 'relic'): Promise<void> {
    await signInRoomPlayer(host, 'alice', game);
    await signInRoomPlayer(guest, 'bob', game);
    await openFriends(host);
    await openFriends(guest);
    await exerciseFriendConsent(host, guest);
    await removeAndRestoreFriendship(host, guest);
    await inviteScheduledSession(host, guest);
    await inviteToRoomAndPlay(host, guest, game);
    await revokePendingInvitation(host, guest, game);
}

async function exerciseFriendConsent(host: Page, guest: Page): Promise<void> {
    const hostPanel = friendsPanel(host);
    const guestPanel = friendsPanel(guest);
    await hostPanel.getByLabel('Friend username', { exact: true }).fill('bob');
    await hostPanel.getByRole('button', { name: 'Send friend request', exact: true }).click();
    await expect(hostPanel).toContainText('Friend request sent');
    await guestPanel.getByRole('button', { name: 'Refresh friends', exact: true }).click();
    await guestPanel.getByRole('button', { name: 'Decline request', exact: true }).click();
    await expect(guestPanel).toContainText('No friends or pending requests');
    await hostPanel.getByRole('button', { name: 'Refresh friends', exact: true }).click();
    await hostPanel.getByRole('button', { name: 'Send friend request', exact: true }).click();
    await hostPanel.getByRole('button', { name: 'Cancel request', exact: true }).click();
    await expect(hostPanel).toContainText('No friends or pending requests');
    await hostPanel.getByRole('button', { name: 'Send friend request', exact: true }).click();
    await guestPanel.getByRole('button', { name: 'Refresh friends', exact: true }).click();
    await guestPanel.getByRole('button', { name: 'Accept request', exact: true }).click();
    await expect(guestPanel.getByRole('button', { name: 'Remove friend', exact: true })).toBeEnabled();
    await hostPanel.getByRole('button', { name: 'Refresh friends', exact: true }).click();
    await expect(hostPanel).toContainText('Online status private');
    await guestPanel.getByRole('checkbox', { name: 'Share when I am online with friends', exact: true }).click();
    await expect(guestPanel.getByRole('checkbox')).toBeChecked();
    await hostPanel.getByRole('button', { name: 'Refresh friends', exact: true }).click();
    await expect(hostPanel).toContainText('Online in this game');
}

async function removeAndRestoreFriendship(host: Page, guest: Page): Promise<void> {
    const hostPanel = friendsPanel(host);
    const guestPanel = friendsPanel(guest);
    await guestPanel.getByRole('checkbox', { name: 'Share when I am online with friends', exact: true }).click();
    await expect(guestPanel.getByRole('checkbox')).not.toBeChecked();
    await hostPanel.getByRole('button', { name: 'Refresh friends', exact: true }).click();
    await expect(hostPanel).toContainText('Online status private');
    await hostPanel.getByRole('button', { name: 'Remove friend', exact: true }).click();
    await expect(hostPanel).toContainText('No friends or pending requests');
    await guestPanel.getByRole('button', { name: 'Refresh friends', exact: true }).click();
    await expect(guestPanel).toContainText('No friends or pending requests');
    await hostPanel.getByRole('button', { name: 'Send friend request', exact: true }).click();
    await expect(hostPanel).toContainText('Friend request sent');
    await guestPanel.getByRole('button', { name: 'Refresh friends', exact: true }).click();
    await guestPanel.getByRole('button', { name: 'Accept request', exact: true }).click();
    await expect(guestPanel.getByRole('button', { name: 'Remove friend', exact: true })).toBeEnabled();
    await hostPanel.getByRole('button', { name: 'Refresh friends', exact: true }).click();
    await expect(hostPanel.getByRole('button', { name: 'Remove friend', exact: true })).toBeEnabled();
}

async function inviteScheduledSession(host: Page, guest: Page): Promise<void> {
    const session = await scheduleThroughControls(host, 20 * 60_000);
    const hostFriends = friendsPanel(host);
    const guestFriends = friendsPanel(guest);
    await hostFriends.getByRole('combobox', { name: 'Invitation destination', exact: true }).selectOption(
        `session:${session.groupId}`
    );
    await hostFriends.getByRole('button', { name: 'Invite to destination', exact: true }).click();
    await expect(hostFriends.getByRole('button', { name: 'Refresh friends', exact: true })).toBeEnabled();
    await guestFriends.getByRole('button', { name: 'Refresh friends', exact: true }).click();
    await guestFriends.getByRole('button', { name: 'View invited session', exact: true }).click();
    const guestSession = guest.getByRole('region', { name: 'Scheduled sessions', exact: true });
    await expect(guestSession.getByRole('article', { name: 'Session details', exact: true })).toBeVisible();
    await guestSession.getByRole('button', { name: 'Reserve a seat', exact: true }).click();
    await expect(guestSession).toContainText('Your seat is reserved');
    await expect(guestSession.getByRole('button', { name: 'Enter lobby', exact: true })).toBeDisabled();
    const hostSession = host.getByRole('region', { name: 'Scheduled sessions', exact: true });
    await hostSession.getByText('Change schedule', { exact: true }).click();
    await hostSession.getByRole('button', { name: 'Cancel session', exact: true }).click();
    await expect(guestSession).toContainText('This session was cancelled.', { timeout: 30_000 });
    await guestFriends.getByRole('button', { name: 'Dismiss invitation', exact: true }).click();
    await expect(guestFriends.getByRole('button', { name: 'View invited session', exact: true })).toHaveCount(0);
}

async function inviteToRoomAndPlay(host: Page, guest: Page, game: 'arena' | 'relic'): Promise<void> {
    await host.getByRole('button', { name: game === 'arena' ? 'New unlisted arena' : 'New unlisted room', exact: true })
        .click();
    const link = host.getByLabel('Room link', { exact: true });
    await expect(link).toHaveValue(/#rallar-room\?/);
    const roomId = toGroupId(await link.inputValue());
    await openFriends(host);
    await friendsPanel(host).getByRole('combobox', { name: 'Invitation destination', exact: true }).selectOption(
        'current'
    );
    await friendsPanel(host).getByRole('button', { name: 'Invite to destination', exact: true }).click();
    await expect(friendsPanel(host).getByRole('button', { name: 'Refresh friends', exact: true })).toBeEnabled();
    await friendsPanel(guest).getByRole('button', { name: 'Refresh friends', exact: true }).click();
    await friendsPanel(guest).getByRole('button', { name: 'Join invited room', exact: true }).click();
    await expect(guest.getByText(`Entered ${roomId}.`, { exact: true })).toBeVisible({ timeout: 30000 });
    await guest.reload();
    if (game === 'arena') {
        await openArenaOperations(guest);
    }
    await openFriends(guest);
    await expect(friendsPanel(guest).getByRole('article', { name: 'Friend alice', exact: true })).toBeVisible();
    await expect(guest.getByText(`Entered ${roomId}.`, { exact: true })).toBeVisible({ timeout: 30000 });
    await playTogetherInRoom(host, guest, game);
}

async function revokePendingInvitation(host: Page, guest: Page, game: 'arena' | 'relic'): Promise<void> {
    if (game === 'arena') {
        await openArenaOperations(host);
        await openArenaOperations(guest);
    }
    const hostPanel = friendsPanel(host);
    const guestPanel = friendsPanel(guest);
    await hostPanel.getByRole('button', { name: 'Invite to destination', exact: true }).click();
    await expect(hostPanel.getByRole('button', { name: 'Refresh friends', exact: true })).toBeEnabled();
    await guestPanel.getByRole('button', { name: 'Refresh friends', exact: true }).click();
    await expect(guestPanel.getByRole('button', { name: 'Join invited room', exact: true })).toBeEnabled();
    await hostPanel.getByRole('button', { name: 'Block', exact: true }).click();
    await expect(hostPanel).toContainText('Blocked. Unblocking will not restore friendship.');
    // Bob still sees the previously fetched invite. The click itself must recheck consent.
    await guestPanel.getByRole('button', { name: 'Join invited room', exact: true }).click();
    await expect(guestPanel.getByRole('alert')).toContainText('no longer available');
    await expect(guestPanel.getByRole('article', { name: 'Friend alice', exact: true })).toHaveCount(0);
    await hostPanel.getByRole('button', { name: 'Unblock', exact: true }).click();
    await expect(hostPanel).toContainText('No friends or pending requests');
}

function friendsPanel(page: Page) {
    return page.getByRole('region', { name: 'Friends and invitations', exact: true });
}

async function openFriends(page: Page): Promise<void> {
    const panel = friendsPanel(page);
    await expect(panel).toBeVisible();
    const details = panel.locator('details');
    if (await details.getAttribute('open') === null) {
        await panel.locator('summary').click();
    }
    await expect(panel.getByRole('button', { name: 'Refresh friends', exact: true })).toBeEnabled();
}
