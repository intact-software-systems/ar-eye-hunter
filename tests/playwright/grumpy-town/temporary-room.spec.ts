import { expect, test } from '@playwright/test';

test('retrying a lost private game creation recovers its room and working invitation', async ({ page, browser }) => {
    let committedRoom: string | undefined;
    await page.route('**/temporary-rooms/requests/*', async route => {
        const committed = await route.fetch();
        expect(committed.ok()).toBe(true);
        committedRoom = (await committed.json()).room.groupId;
        await route.abort();
    }, { times: 1 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Start a game', exact: true }).click({ timeout: 5000 });
    await expect(page.getByRole('alert')).toContainText('Try again');
    await page.reload();
    await page.getByRole('button', { name: 'Start a game', exact: true }).click();
    const link = page.getByLabel('Guest invitation link');
    await expect(link).toHaveValue(/\/guest#/);
    const invitation = new URL(await link.inputValue());
    expect(new URLSearchParams(invitation.hash.slice(1)).get('room')).toBe(committedRoom);
    const friend = await browser.newPage();
    try {
        await friend.goto(invitation.href);
        await expect(friend.getByText('3 of 4 seats available')).toBeVisible();
        await expect(page.getByText(/1 player\b/)).toBeVisible();
        await friend.getByRole('button', { name: 'Join this town' }).click();
        await expect(friend.getByRole('heading', { name: 'Your town lobby' })).toBeVisible();
        await expect(page.getByText(/2 players\b/)).toBeVisible();
    }
    finally {
        await friend.close();
    }
});

test('four fresh browsers play a private round and rematch without an account', async ({ browser }) => {
    test.setTimeout(420_000);
    const contexts = await Promise.all(Array.from({ length: 4 }, () => browser.newContext()));
    try {
        const [creator, ...friends] = await Promise.all(contexts.map(context => context.newPage()));
        const accountCalls: string[] = [];
        for (const context of contexts) {
            context.on('request', request => {
                if (/\/api\/auth\/(register|login)/.test(request.url())) accountCalls.push(request.method());
            });
        }
        await creator.goto('/');
        await creator.getByRole('button', { name: 'Start a game', exact: true }).click();
        const link = creator.getByLabel('Guest invitation link');
        await expect(link).toHaveValue(/\/guest#/);
        const invitation = await link.inputValue();
        await creator.getByRole('button', { name: 'Host match', exact: true }).click();
        for (const friend of friends) {
            await friend.goto(invitation);
            await friend.getByRole('button', { name: 'Join this town' }).click();
            await expect(friend.getByRole('button', { name: 'Ready', exact: true })).toBeEnabled({ timeout: 25_000 });
        }
        const players = [creator, ...friends];
        let previousRound: string | null = null;
        for (let round = 0; round < 2; round++) {
            for (const player of players) await player.getByRole('button', { name: 'Ready', exact: true }).click();
            await creator.getByRole('button', { name: 'Start round' }).click();
            for (const player of players) {
                await expect(player.locator('#online-game')).toHaveAttribute('data-phase', 'playing', { timeout: 25_000 });
            }
            const matchId = await creator.locator('#online-game').getAttribute('data-match-id');
            expect(matchId).toBeTruthy();
            for (const friend of friends) await expect(friend.locator('#online-game')).toHaveAttribute('data-match-id', matchId!);
            if (round === 0) {
                previousRound = matchId;
                await creator.getByRole('button', { name: 'New round' }).click({ timeout: 240_000 });
            } else {
                expect(matchId).not.toBe(previousRound);
            }
        }
        expect(accountCalls).toEqual([]);
    } finally {
        await Promise.all(contexts.map(context => context.close()));
    }
});

test('a temporary manager can rotate an invitation and remove a player from the room', async ({ page: owner, browser }) => {
    await owner.goto('/');
    await owner.getByRole('button', { name: 'Start a game', exact: true }).click();
    const link = owner.getByLabel('Guest invitation link');
    await expect(link).toHaveValue(/\/guest#/);
    const old = await link.inputValue();
    await owner.getByRole('button', { name: 'Replace invitation' }).click({ timeout: 4000 });
    await expect(link).not.toHaveValue(old);
    const friend = await browser.newPage();
    try {
        await friend.goto(old);
        await expect(friend.getByRole('alert')).toContainText('fresh invitation');
        await friend.goto(await link.inputValue());
        await friend.getByRole('button', { name: 'Join this town' }).click();
        await owner.getByRole('button', { name: 'Remove guest' }).click();
        await expect(friend.getByRole('alert')).toContainText('fresh invitation');
    } finally {
        await friend.close();
    }
});

test('handing a town to a present player preserves its director and transfers moderation across reload', async ({ page: creator, browser }) => {
    test.setTimeout(60_000);
    const recipient = await browser.newPage();
    const replacement = await browser.newPage();
    try {
        await creator.goto('/');
        await creator.getByRole('button', { name: 'Start a game', exact: true }).click();
        const invitation = creator.getByLabel('Guest invitation link');
        await expect(invitation).toHaveValue(/\/guest#/);
        await recipient.goto(await invitation.inputValue());
        await recipient.getByRole('button', { name: 'Join this town' }).click();
        await creator.getByRole('button', { name: 'Host match', exact: true }).click();
        await expect(creator.locator('#match-controls')).toContainText('You direct this match');
        await creator.getByRole('button', { name: 'Hand over management' }).click({ timeout: 5000 });
        await expect(recipient.getByRole('button', { name: 'Invite guests' })).toBeVisible();
        await expect(creator.locator('#match-controls')).toContainText('You direct this match');
        await creator.reload();
        await expect(creator.getByRole('heading', { name: 'Your town lobby' })).toBeVisible();
        await expect(creator.getByRole('button', { name: /Invite guests|Replace invitation/ })).toHaveCount(0);
        await recipient.getByRole('button', { name: 'Invite guests' }).click();
        await replacement.goto(await recipient.getByLabel('Guest invitation link').inputValue());
        await replacement.getByRole('button', { name: 'Join this town' }).click();
        await expect(recipient.getByText(/3 players\b/)).toBeVisible();
    } finally {
        await replacement.close();
        await recipient.close();
    }
});

test('a returning creator opens the saved game from the landing page in a new tab', async ({ page, context }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Start a game', exact: true }).click();
    const link = page.getByLabel('Guest invitation link');
    await expect(link).toHaveValue(/\/guest#/);
    const invite = await link.inputValue();
    await page.close();
    const reopened = await context.newPage();
    await reopened.goto('/');
    await reopened.getByRole('link', { name: 'Return to game' }).click({ timeout: 4000 });
    await expect(reopened.getByLabel('Guest invitation link')).toHaveValue(invite);
    await expect(reopened.getByText(/1 player\b/)).toBeVisible();
});
