import { expect, type Page } from '@playwright/test';

export async function moveTogetherJourney(host: Page, guest: Page, game: 'arena' | 'relic'): Promise<void> {
    const { source, destination } = await prepareMoveRooms(host, guest, game);
    await confirmMoveWithConsentChanges(host, guest, source, destination);
    await commitMoveWithNetworkRecovery(host, guest, source, destination);
    await returnThroughRetainedMembership(host, guest, game, source, destination);
    await playInDestination(host, guest, game);
}

async function confirmMoveWithConsentChanges(
    host: Page,
    guest: Page,
    source: string,
    destination: string
): Promise<void> {
    const hostMove = host.getByRole('region', { name: 'Move together', exact: true });
    const guestMove = guest.getByRole('region', { name: 'Move together', exact: true });
    await expect(host.getByRole('region', { name: `Members of ${source}`, exact: true })).toContainText('2 present');
    await hostMove.getByLabel('Destination room reference', { exact: true }).fill(destination);
    await hostMove.getByRole('button', { name: 'Propose move', exact: true }).click();
    await expect(guestMove).toContainText(destination);
    await hostMove.getByRole('button', { name: 'Confirm move', exact: true }).click();
    await hostMove.getByRole('button', { name: 'Withdraw confirmation', exact: true }).click();
    await expect(hostMove.getByRole('button', { name: 'Move everyone', exact: true })).toBeDisabled();
    await guestMove.getByRole('button', { name: 'Decline move', exact: true }).click();
    await expect(hostMove.getByRole('status')).toContainText('cancelled');
    await expect(host.getByRole('region', { name: `Members of ${source}`, exact: true })).toContainText('2 present');
    await hostMove.getByRole('button', { name: 'Propose move', exact: true }).click();
    await expect(guestMove.getByRole('status')).toContainText('proposed');
    await hostMove.getByLabel('Move history', { exact: true }).selectOption({ index: 1 });
    await expect(hostMove.getByRole('status')).toContainText('cancelled');
    await hostMove.getByLabel('Move history', { exact: true }).selectOption({ index: 0 });
    await expect(hostMove.getByRole('status')).toContainText('proposed');
    await hostMove.getByRole('button', { name: 'Confirm move', exact: true }).click();
    await expect(hostMove.getByRole('button', { name: 'Move everyone', exact: true })).toBeDisabled();
    await guestMove.getByRole('button', { name: 'Confirm move', exact: true }).click();
    await expect(hostMove.getByRole('button', { name: 'Move everyone', exact: true })).toBeEnabled();
}

async function commitMoveWithNetworkRecovery(
    host: Page,
    guest: Page,
    source: string,
    destination: string
): Promise<void> {
    const hostMove = host.getByRole('region', { name: 'Move together', exact: true });
    const guestMove = guest.getByRole('region', { name: 'Move together', exact: true });
    const membershipLeaves: string[] = [];
    for (const page of [host, guest]) {
        page.on('request', (request) => {
            if (request.method() === 'PUT' && /\/members\/[^/]+\/requests\//.test(request.url())) {
                membershipLeaves.push(request.url());
            }
        });
    }
    const faults = await interceptMoveActivation(host, guest, destination);
    await guest.context().setOffline(true);
    await hostMove.getByRole('button', { name: 'Move everyone', exact: true }).click();
    await expect(host.getByText(`Entered ${destination}.`, { exact: true })).toBeVisible({ timeout: 30000 });
    expect(faults.lostCommitResponses()).toBeGreaterThan(0);
    await guest.context().setOffline(false);
    await guestMove.getByRole('button', { name: 'Refresh move', exact: true }).click();
    // Network restoration can precede the replacement socket opening. Exercise the visible retry
    // until entry reaches the injected HTTP denial; a connection error alone does not prove that fault.
    const retryEntry = guestMove.getByRole('button', { name: 'Retry destination entry', exact: true });
    await expect(retryEntry).toBeEnabled();
    await expect(async () => {
        await retryEntry.click({ timeout: 1000 });
        await expect(guestMove.getByRole('alert')).toContainText('403', { timeout: 1000 });
    }).toPass({ timeout: 15000 });
    expect(faults.deniedPresenceRequests()).toBeGreaterThan(0);
    await expect(guest.getByText(`Entered ${source}.`, { exact: true })).toBeVisible({ timeout: 30000 });
    await expect(guestMove).toContainText('1 of 2 arrived');
    await guest.unroute(faults.destinationPresence);
    await retryEntry.click();
    for (const page of [host, guest]) {
        await expect(page.getByText(`Entered ${destination}.`, { exact: true })).toBeVisible({ timeout: 30000 });
        await expect(page.getByRole('region', { name: `Members of ${source}`, exact: true })).toContainText(
            '0 present · 2 away'
        );
        await expect(page.getByRole('region', { name: `Members of ${destination}`, exact: true })).toContainText(
            '2 present'
        );
    }
    expect(membershipLeaves).toEqual([]);
    await expect(hostMove).toContainText('2 of 2 arrived');
}

async function returnThroughRetainedMembership(
    host: Page,
    guest: Page,
    game: 'arena' | 'relic',
    source: string,
    destination: string
): Promise<void> {
    const guestMove = guest.getByRole('region', { name: 'Move together', exact: true });
    await guest.reload();
    if (game === 'arena') {
        await openArenaOperations(guest);
    }
    await expect(guest.getByText(`Entered ${destination}.`, { exact: true })).toBeVisible({ timeout: 30000 });
    await expect(guestMove).toContainText('2 of 2 arrived');
    // Retained membership remains usable, and a completed move must not pull a returning player away.
    await guest.getByLabel('Room reference', { exact: true }).fill(source);
    await guest.getByRole('button', { name: 'Enter room', exact: true }).click();
    await expect(guest.getByText(`Entered ${source}.`, { exact: true })).toBeVisible({ timeout: 30000 });
    await guestMove.getByRole('button', { name: 'Refresh move', exact: true }).click();
    await expect(guest.getByText(`Entered ${source}.`, { exact: true })).toBeVisible({ timeout: 30000 });
    await expect(guest.getByRole('region', { name: `Members of ${source}`, exact: true })).toContainText(
        '1 present · 1 away'
    );
    await guest.getByLabel('Room reference', { exact: true }).fill(destination);
    await guest.getByRole('button', { name: 'Enter room', exact: true }).click();
    await expect(guest.getByText(`Entered ${destination}.`, { exact: true })).toBeVisible({ timeout: 30000 });
}

async function playInDestination(host: Page, guest: Page, game: 'arena' | 'relic'): Promise<void> {
    if (game === 'arena') {
        const appoint = host.getByRole('button', { name: 'Appoint this SPA', exact: true });
        if (await appoint.isEnabled()) {
            await appoint.click();
        }
        await host.getByRole('button', { name: '1m', exact: true }).click();
        await expect(guest.locator('.match-panel strong')).toHaveText(/^[01]:\d{2}$/);
        await expect(
            host.getByRole('region', { name: 'Move together', exact: true }).getByRole('button', {
                name: 'Propose move',
                exact: true
            })
        ).toBeDisabled();
    }
    else {
        await expect(host.locator('.lobby-party-row')).toHaveCount(0);
        await expect(guest.locator('.lobby-party-row')).toHaveCount(0);
        for (const page of [host, guest]) {
            await page.getByRole('button', { name: /Join as/ }).click();
        }
        await expect(host.locator('.lobby-party-row')).toHaveCount(2);
        await host.locator('.lobby-begin-btn').click();
        await expect(guest.getByRole('button', { name: 'Submit Plan' })).toBeEnabled();
        await host.getByRole('button', { name: 'Submit Plan' }).click();
        await guest.getByRole('button', { name: 'Submit Plan' }).click();
        for (const hunter of [host, guest]) {
            await expect(hunter.locator('.turn-plan-status .panel-label')).toHaveText('Round 2', { timeout: 30000 });
            await expect(
                hunter.getByRole('region', { name: 'Move together', exact: true }).getByRole('button', {
                    name: 'Propose move',
                    exact: true
                })
            ).toBeDisabled();
        }
    }
}

function toGroupId(link: string): string {
    const id = new URLSearchParams(new URL(link).hash.slice('#rallar-room?'.length)).get('groupId');
    if (!id) {
        throw new Error('Room sharing did not expose a group identity');
    }
    return id;
}

async function openArenaOperations(page: Page): Promise<void> {
    const panel = page.getByRole('region', { name: 'Arena operations', exact: true });
    if (await panel.isVisible()) {
        return;
    }
    const button = page.getByRole('button', { name: 'Ops', exact: true });
    await expect(panel.or(button).first()).toBeVisible({ timeout: 30000 });
    if (!await panel.isVisible()) {
        await button.click();
    }
    await expect(panel).toBeVisible();
}

export async function moveConsentRecoveryJourney(host: Page, guest: Page, game: 'arena' | 'relic'): Promise<void> {
    const { source, destination } = await prepareMoveRooms(host, guest, game);
    const hostMove = host.getByRole('region', { name: 'Move together', exact: true });
    const guestMove = guest.getByRole('region', { name: 'Move together', exact: true });
    await expect(host.getByRole('region', { name: `Members of ${source}`, exact: true })).toContainText('2 present');
    await hostMove.getByLabel('Destination room reference', { exact: true }).fill(destination);
    await hostMove.getByRole('button', { name: 'Propose move', exact: true }).click();
    await hostMove.getByRole('button', { name: 'Confirm move', exact: true }).click();
    await expect(hostMove.getByRole('button', { name: 'Withdraw confirmation', exact: true })).toBeVisible();
    await guest.reload();
    if (game === 'arena') {
        await openArenaOperations(guest);
    }
    await expect(guest.getByText(`Entered ${source}.`, { exact: true })).toBeVisible({ timeout: 30000 });
    await guestMove.getByRole('button', { name: 'Confirm move', exact: true }).click();
    await expect(guestMove.getByRole('status')).toContainText('cancelled');
    await expect(host.getByText(`Entered ${source}.`, { exact: true })).toBeVisible({ timeout: 30000 });
    await expect(hostMove.getByRole('status')).toContainText('cancelled');
    await hostMove.getByRole('button', { name: 'Propose move', exact: true }).click();
    await hostMove.getByRole('button', { name: 'Confirm move', exact: true }).click();
    await expect(guestMove.getByRole('status')).toContainText('proposed');
    await host.getByRole('button', { name: 'Logout', exact: true }).click();
    await registerDifferentAccount(host);
    await guestMove.getByRole('button', { name: 'Confirm move', exact: true }).click();
    await expect(guestMove.getByRole('status')).toContainText('cancelled');
    await expect(guest.getByText(`Entered ${source}.`, { exact: true })).toBeVisible({ timeout: 30000 });
    // A new proposal observes the remaining cohort; the server expires it without another mutation.
    await guestMove.getByLabel('Destination room reference', { exact: true }).fill(destination);
    await guestMove.getByRole('button', { name: 'Propose move', exact: true }).click();
    await expect(guestMove.getByRole('status')).toContainText('proposed');
    await expect(guestMove.getByRole('status')).toContainText('expired', { timeout: 135000 });
    await expect(guest.getByText(`Entered ${source}.`, { exact: true })).toBeVisible({ timeout: 30000 });
}

async function prepareMoveRooms(
    host: Page,
    guest: Page,
    game: 'arena' | 'relic',
    participation: 'player' | 'spectator' = 'player'
): Promise<{ source: string; destination: string; }> {
    const base = game === 'arena' ? 'http://127.0.0.1:5186' : 'http://127.0.0.1:5175';
    for (const [page, username] of [[host, 'alice'], [guest, 'bob']] as const) {
        await page.goto(base);
        if (game === 'arena') {
            await openArenaOperations(page);
        }
        await page.getByLabel('Username', { exact: true }).fill(username);
        await page.getByLabel('Password', { exact: true }).fill('secret');
        await page.getByRole('button', { name: game === 'arena' ? 'Enter Arena' : 'Enter', exact: true }).click();
    }
    const create = host.getByRole('button', {
        name: game === 'arena' ? 'New unlisted arena' : 'New unlisted room',
        exact: true
    });
    await create.click();
    const link = host.getByLabel('Room link', { exact: true });
    await expect(link).toHaveValue(/#rallar-room\?/);
    const destinationLink = await link.inputValue();
    const destination = toGroupId(destinationLink);
    await create.click();
    await expect(link).not.toHaveValue(destinationLink);
    const source = toGroupId(await link.inputValue());
    await guest.getByLabel('Room reference', { exact: true }).fill(source);
    if (participation === 'spectator') {
        await guest.getByRole('combobox', { name: 'Participation', exact: true }).selectOption('spectator');
    }
    await guest.getByRole('button', {
        name: participation === 'spectator' && game === 'relic' ? 'Watch room' : 'Enter room',
        exact: true
    })
        .click();
    await expect(guest.getByText(`Entered ${source}.`, { exact: true })).toBeVisible({ timeout: 30000 });
    return { source, destination };
}

async function interceptMoveActivation(host: Page, guest: Page, destination: string) {
    // The server commits, but the organizer loses every commit response. Recovery must read the decision.
    let lostCommitResponses = 0;
    await host.route('**/group-moves/requests/*', async (route) => {
        if (route.request().postDataJSON()?.action !== 'commit') {
            await route.continue();
            return;
        }
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        lostCommitResponses++;
        await route.abort('connectionreset');
    });
    // Admission succeeds for both players even though one browser cannot establish destination presence.
    let deniedPresenceRequests = 0;
    const destinationPresence = new RegExp(`/groups/${destination}/sessions/`);
    await guest.route(destinationPresence, async (route) => {
        if (route.request().method() === 'PUT') {
            deniedPresenceRequests++;
            await route.fulfill({
                status: 403,
                contentType: 'text/plain',
                body: 'Destination entry temporarily denied by test network'
            });
        }
        else {
            await route.continue();
        }
    });
    return {
        lostCommitResponses: () => lostCommitResponses,
        deniedPresenceRequests: () => deniedPresenceRequests,
        destinationPresence
    };
}

async function registerDifferentAccount(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Register', exact: true }).click();
    await page.getByLabel('Username', { exact: true }).fill(`move-observer-${crypto.randomUUID()}`);
    await page.getByLabel('Display name', { exact: true }).fill('Different player');
    await page.getByLabel('Password', { exact: true }).fill(`test-${crypto.randomUUID()}`);
    await page.getByRole('button', { name: 'Create Hunter', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Move together', exact: true });
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: 'Refresh move', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Confirm move', exact: true })).toHaveCount(0);
    await expect(panel.getByLabel('Move history', { exact: true })).toHaveCount(0);
}

export async function moveLeavesSpectatorJourney(host: Page, watcher: Page, game: 'arena' | 'relic'): Promise<void> {
    const { source, destination } = await prepareMoveRooms(host, watcher, game, 'spectator');
    const hostMove = host.getByRole('region', { name: 'Move together', exact: true });
    const watcherMove = watcher.getByRole('region', { name: 'Move together', exact: true });
    const watching =
        (game === 'arena' ? watcher.getByRole('region', { name: 'Arena operations', exact: true }) : watcher).getByText(
            'Watching',
            { exact: true }
        );
    await expect(watching).toBeVisible();
    await hostMove.getByLabel('Destination room reference', { exact: true }).fill(destination);
    await hostMove.getByRole('button', { name: 'Propose move', exact: true }).click();
    await hostMove.getByRole('button', { name: 'Confirm move', exact: true }).click();
    await hostMove.getByRole('button', { name: 'Move everyone', exact: true }).click();
    await expect(host.getByText(`Entered ${destination}.`, { exact: true })).toBeVisible({ timeout: 30000 });
    await expect(hostMove).toContainText('1 of 1 arrived');
    await watcherMove.getByRole('button', { name: 'Refresh move', exact: true }).click();
    await expect(watcher.getByText(`Entered ${source}.`, { exact: true })).toBeVisible({ timeout: 30000 });
    await expect(watching).toBeVisible();
    await expect(watcherMove.getByRole('button', { name: 'Confirm move', exact: true })).toHaveCount(0);
    await expect(watcherMove.getByRole('button', { name: 'Propose move', exact: true })).toBeDisabled();
}
