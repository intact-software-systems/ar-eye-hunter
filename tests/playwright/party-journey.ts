import { expect, type Page } from '@playwright/test';
import { openArenaOperations, playTogetherInRoom, signInRoomPlayer, toGroupId } from './room-player-journey.ts';
import { assertIdleSocialReads } from './view-push-observation.ts';

export async function partyPlayJourney(host: Page, guest: Page, game: 'arena' | 'relic'): Promise<void> {
    host.setDefaultTimeout(15000);
    guest.setDefaultTimeout(15000);
    await signInRoomPlayer(host, 'alice', game);
    await signInRoomPlayer(guest, 'bob', game);
    await host.getByRole('button', { name: game === 'arena' ? 'New unlisted arena' : 'New unlisted room', exact: true })
        .click();
    const destinationLink = host.getByLabel('Room link', { exact: true });
    await expect(destinationLink).toHaveValue(/#rallar-room\?/);
    const destination = toGroupId(await destinationLink.inputValue());
    await becomeFriends(host, guest);
    await formParty(host, guest, game);
    const source = await matchParty(host, guest);
    await moveParty(host, guest, source, destination);
    await playTogetherInRoom(host, guest, game);
    await repeatPartyPlay(host, guest, game);
    if (game === 'arena') {
        await openArenaOperations(host);
        await openArenaOperations(guest);
    }
    const hostParty = host.getByRole('region', { name: 'Party', exact: true });
    const guestParty = guest.getByRole('region', { name: 'Party', exact: true });
    await expect(hostParty).toContainText('2 of 2 seats');
    await expect(guestParty).toContainText('2 of 2 seats');
    await guestParty.getByRole('button', { name: 'Leave party', exact: true }).click();
    await expect(guestParty.getByRole('button', { name: 'Create party', exact: true })).toBeEnabled();
    await expect(hostParty).toContainText('1 of 2 seats');
    await expect(guest.getByText(`Entered ${destination}.`, { exact: true })).toBeVisible();
    await hostParty.getByRole('button', { name: 'Disband party', exact: true }).click();
    await expect(hostParty.getByRole('button', { name: 'Create party', exact: true })).toBeEnabled();
    const friends = host.getByRole('region', { name: 'Friends and invitations', exact: true });
    if (!await friends.getByRole('button', { name: 'Remove friend', exact: true }).isVisible()) {
        await friends.locator('summary').click();
    }
    await friends.getByRole('button', { name: 'Remove friend', exact: true }).click();
    await expect(friends).toContainText('No friends or pending requests');
}

async function formParty(host: Page, guest: Page, game: 'arena' | 'relic'): Promise<void> {
    const hostParty = host.getByRole('region', { name: 'Party', exact: true });
    const guestParty = guest.getByRole('region', { name: 'Party', exact: true });
    await hostParty.getByRole('button', { name: 'Create party', exact: true }).click();
    await declineAndRevokeInvitations(host, guest);
    await hostParty.getByRole('button', { name: 'Invite bob to party', exact: true }).click();
    await acceptWithLostResponse(guest);
    await expect(hostParty).toContainText('2 of 2 seats');
    await expect(guestParty).toContainText('2 of 2 seats');
    await assertIdleSocialReads(guest);
    await guest.reload();
    if (game === 'arena') {
        await openArenaOperations(guest);
    }
    await expect(guestParty).toContainText('2 of 2 seats');
    await expect(guestParty.getByRole('button', { name: 'Disband party', exact: true })).toHaveCount(0);
    await hostParty.getByRole('button', { name: 'Make bob party leader', exact: true }).click();
    await expect(hostParty.getByRole('button', { name: 'Disband party', exact: true })).toHaveCount(0);
    await guestParty.getByRole('button', { name: 'Make alice party leader', exact: true }).click();
    await expect(hostParty.getByRole('button', { name: 'Disband party', exact: true })).toBeEnabled();
    await recoverPartyLeadership(host, guest, game);
    await replacePartyAccount(guest, game);
}

async function matchParty(host: Page, guest: Page): Promise<string> {
    const hostMatch = host.getByRole('region', { name: 'Find players', exact: true });
    const guestMatch = guest.getByRole('region', { name: 'Find players', exact: true });
    await expect(guestMatch.getByRole('button', { name: 'Find a game with party', exact: true })).toBeDisabled();
    await hostMatch.getByRole('button', { name: 'Find a game with party', exact: true }).click();
    await expect(hostMatch).toContainText('Players found');
    await expect(guestMatch).toContainText('Players found');
    await hostMatch.getByRole('button', { name: 'Confirm match', exact: true }).click();
    await expect(guestMatch.getByRole('button', { name: 'Enter matched room', exact: true })).toHaveCount(0);
    await guestMatch.getByRole('button', { name: 'Confirm match', exact: true }).click();
    const previousLink = await host.getByLabel('Room link', { exact: true }).inputValue();
    await hostMatch.getByRole('button', { name: 'Enter matched room', exact: true }).click();
    await guestMatch.getByRole('button', { name: 'Enter matched room', exact: true }).click();
    const link = host.getByLabel('Room link', { exact: true });
    await expect(link).toHaveValue(/#rallar-room\?/);
    await expect(link).not.toHaveValue(previousLink);
    const roomId = toGroupId(await link.inputValue());
    await expect(guest.getByText(`Entered ${roomId}.`, { exact: true })).toBeVisible({ timeout: 30000 });
    await expect(host.getByLabel('Room link', { exact: true })).toHaveValue(new RegExp(`groupId=${roomId}(?:&|$)`));
    // The destination's sole owner retains membership when ordinary entry cannot leave it.
    const hostEntry = host.getByRole('region', { name: 'Shared room entry', exact: true });
    await expect(hostEntry.getByRole('alert')).toContainText('leaving the previous room failed');
    await hostEntry.getByRole('button', { name: 'Cancel room entry', exact: true }).click();
    return roomId;
}

async function acceptWithLostResponse(guest: Page): Promise<void> {
    const endpoint = '**/api/parties/apps/*/workspaces/*/requests/*';
    const requests: string[] = [];
    await guest.route(endpoint, async (route) => {
        requests.push(route.request().url());
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        await route.abort('failed');
    });
    const party = guest.getByRole('region', { name: 'Party', exact: true });
    await party.getByRole('button', { name: 'Accept party invitation', exact: true }).click();
    const retry = party.getByRole('button', { name: 'Retry party request', exact: true });
    await expect(retry).toBeEnabled({ timeout: 40000 });
    expect(requests.length).toBeGreaterThan(0);
    expect(new Set(requests).size).toBe(1);
    await guest.unroute(endpoint);
    const replay = guest.waitForRequest((request) => request.method() === 'POST' && request.url() === requests[0]);
    await retry.click();
    await replay;
    await expect(retry).toHaveCount(0);
}

async function moveParty(host: Page, guest: Page, source: string, destination: string): Promise<void> {
    const hostMove = host.getByRole('region', { name: 'Move together', exact: true });
    const guestMove = guest.getByRole('region', { name: 'Move together', exact: true });
    await expect(hostMove).toContainText('Your whole party moves together');
    await expect(guestMove.getByRole('button', { name: 'Propose move', exact: true })).toBeDisabled();
    await hostMove.getByLabel('Destination room reference', { exact: true }).fill(destination);
    await hostMove.getByRole('button', { name: 'Propose move', exact: true }).click();
    await hostMove.getByRole('button', { name: 'Confirm move', exact: true }).click();
    await expect(hostMove.getByRole('button', { name: 'Move everyone', exact: true })).toBeDisabled();
    await guestMove.getByRole('button', { name: 'Confirm move', exact: true }).click();
    await hostMove.getByRole('button', { name: 'Move everyone', exact: true }).click();
    for (const page of [host, guest]) {
        await expect(page.getByText(`Entered ${destination}.`, { exact: true })).toBeVisible({ timeout: 30000 });
        await expect(page.getByRole('region', { name: 'Move together', exact: true })).toContainText('2 of 2 arrived');
        await expect(page.getByRole('region', { name: `Members of ${source}`, exact: true })).toContainText(
            '0 present · 2 away'
        );
        await expect(page.getByRole('region', { name: 'Party', exact: true })).toContainText('2 of 2 seats');
    }
}

async function repeatPartyPlay(host: Page, guest: Page, game: 'arena' | 'relic'): Promise<void> {
    if (game === 'relic') {
        await escapeTogether(host, guest);
    }
    const hostResults = game === 'arena'
        ? host.getByRole('dialog', { name: 'Match results' })
        : host.locator('.victory-panel');
    const guestResults = game === 'arena'
        ? guest.getByRole('dialog', { name: 'Match results' })
        : guest.locator('.victory-panel');
    await expect(hostResults).toBeVisible({ timeout: 65000 });
    await expect(guestResults).toBeVisible({ timeout: 15000 });
    const startAgain = host.getByRole('button', {
        name: game === 'arena' ? 'Start next match' : 'Start next expedition',
        exact: true
    });
    await expect(startAgain).toBeDisabled();
    await host.getByRole('button', { name: 'Play again', exact: true }).click();
    await expect(startAgain).toBeDisabled();
    await guest.getByRole('button', { name: 'Play again', exact: true }).click();
    await expect(startAgain).toBeEnabled();
    await startAgain.click();
    await expect(hostResults).toBeHidden();
    await expect(guestResults).toBeHidden();
    if (game === 'arena') {
        await openArenaOperations(host);
        await openArenaOperations(guest);
        await expect(host.locator('.match-panel strong')).toHaveText(/^[01]:\d{2}$/);
        await expect(guest.locator('.match-panel strong')).toHaveText(/^[01]:\d{2}$/);
    }
    else {
        for (const page of [host, guest]) {
            await expect(page.locator('.turn-plan-status .panel-label')).toHaveText('Round 1');
            await page.locator('.action-picker').getByRole('button', { name: /^Search/ }).click();
        }
        await submitPartyPlans(host, guest);
        for (const page of [host, guest]) {
            await expect(page.locator('.turn-plan-status .panel-label')).toHaveText('Round 2', { timeout: 30000 });
        }
    }
}

async function escapeTogether(host: Page, guest: Page): Promise<void> {
    for (const [index, destination] of ['Hallway', 'Trap Room', 'Monster Lair', 'Exit'].entries()) {
        for (const page of [host, guest]) {
            await expect(page.locator('.turn-plan-status .panel-label')).toHaveText(`Round ${index + 2}`);
            await page.locator('.action-picker').getByRole('button', { name: /^Move/ }).click();
            await page.locator('.target-choice-grid').getByRole('button', { name: new RegExp(`^${destination}`) })
                .click();
        }
        await submitPartyPlans(host, guest);
        for (const page of [host, guest]) {
            await expect(page.locator('.turn-plan-status .panel-label')).toHaveText(`Round ${index + 3}`, {
                timeout: 30000
            });
        }
    }
    for (const page of [host, guest]) {
        await page.locator('.action-picker').getByRole('button', { name: /^Escape/ }).click();
    }
    await submitPartyPlans(host, guest);
}

async function submitPartyPlans(host: Page, guest: Page): Promise<void> {
    for (const page of [host, guest]) {
        await page.getByRole('button', { name: /^Submit Plan(?: ↵)?$/ }).click();
    }
}

async function becomeFriends(host: Page, guest: Page): Promise<void> {
    for (const page of [host, guest]) {
        await page.getByRole('region', { name: 'Friends and invitations', exact: true }).locator('summary').click();
    }
    const hostFriends = host.getByRole('region', { name: 'Friends and invitations', exact: true });
    const guestFriends = guest.getByRole('region', { name: 'Friends and invitations', exact: true });
    await hostFriends.getByLabel('Friend username', { exact: true }).fill('bob');
    await hostFriends.getByRole('button', { name: 'Send friend request', exact: true }).click();
    await expect(hostFriends).toContainText('Friend request sent');
    await guestFriends.getByRole('button', { name: 'Refresh friends', exact: true }).click();
    await guestFriends.getByRole('button', { name: 'Accept request', exact: true }).click();
    await expect(guestFriends.getByRole('button', { name: 'Remove friend', exact: true })).toBeEnabled();
    await hostFriends.getByRole('button', { name: 'Refresh friends', exact: true }).click();
    await expect(hostFriends.getByRole('button', { name: 'Remove friend', exact: true })).toBeEnabled();
}

async function declineAndRevokeInvitations(host: Page, guest: Page): Promise<void> {
    const hostParty = host.getByRole('region', { name: 'Party', exact: true });
    const guestParty = guest.getByRole('region', { name: 'Party', exact: true });
    await hostParty.getByRole('button', { name: 'Invite bob to party', exact: true }).click();
    await guestParty.getByRole('button', { name: 'Decline party invitation', exact: true }).click();
    await expect(guestParty.getByRole('button', { name: 'Accept party invitation', exact: true })).toHaveCount(0);
    await expect(hostParty).toContainText('1 of 2 seats');
    await hostParty.getByRole('button', { name: 'Invite bob to party', exact: true }).click();
    await expect(guestParty.getByRole('button', { name: 'Accept party invitation', exact: true })).toBeEnabled();
    await hostParty.getByRole('button', { name: 'Revoke party invitation', exact: true }).click();
    await expect(guestParty.getByRole('button', { name: 'Accept party invitation', exact: true })).toHaveCount(0);
    await expect(guestParty.getByRole('button', { name: 'Create party', exact: true })).toBeEnabled();
}

async function recoverPartyLeadership(host: Page, guest: Page, game: 'arena' | 'relic'): Promise<void> {
    const returnLink = await host.getByLabel('Room link', { exact: true }).inputValue();
    const hostParty = host.getByRole('region', { name: 'Party', exact: true });
    const guestParty = guest.getByRole('region', { name: 'Party', exact: true });
    await host.goto('about:blank');
    // Takeover follows the real server presence lease, never a browser offline hint.
    await expect(guestParty.getByRole('listitem').filter({ hasText: 'alice' })).toContainText('Away', {
        timeout: 70000
    });
    await guestParty.getByRole('button', { name: 'Take party leadership', exact: true }).click();
    await expect(guestParty.getByRole('button', { name: 'Disband party', exact: true })).toBeEnabled();
    await expect(guest.getByRole('button', { name: 'Find a game with party', exact: true })).toBeDisabled();
    await host.goto(returnLink);
    if (game === 'arena') {
        await openArenaOperations(host);
    }
    await expect(hostParty.getByRole('listitem').filter({ hasText: 'alice' })).toContainText('Present');
    await expect(hostParty.getByRole('button', { name: 'Disband party', exact: true })).toHaveCount(0);
    await guestParty.getByRole('button', { name: 'Make alice party leader', exact: true }).click();
    await expect(hostParty.getByRole('button', { name: 'Disband party', exact: true })).toBeEnabled();
}

async function replacePartyAccount(page: Page, game: 'arena' | 'relic'): Promise<void> {
    const party = page.getByRole('region', { name: 'Party', exact: true });
    for (const username of ['alice', 'bob']) {
        await page.getByRole('button', { name: 'Logout', exact: true }).click();
        await expect(party.getByRole('button', { name: 'Leave party', exact: true })).toHaveCount(0);
        await page.getByLabel('Username', { exact: true }).fill(username);
        await page.getByLabel('Password', { exact: true }).fill('secret');
        await page.getByRole('button', { name: game === 'arena' ? 'Enter Arena' : 'Enter', exact: true }).click();
        await expect(party).toContainText('2 of 2 seats');
        const disband = party.getByRole('button', { name: 'Disband party', exact: true });
        if (username === 'alice') {
            await expect(disband).toBeEnabled();
        }
        else {
            await expect(disband).toHaveCount(0);
        }
    }
}
