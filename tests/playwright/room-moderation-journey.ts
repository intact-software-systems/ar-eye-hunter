import { expect, type Page } from '@playwright/test';
import { playTogetherInRoom, signInRoomPlayer, toGroupId } from './room-player-journey.ts';

export async function roomModerationJourney(host: Page, guest: Page, game: 'arena' | 'relic'): Promise<void> {
    for (const page of [host, guest]) {
        page.on('pageerror', (error) => {
            throw error;
        });
    }
    await signInRoomPlayer(host, 'alice', game);
    await signInRoomPlayer(guest, 'bob', game);
    await host.getByRole('button', { name: game === 'arena' ? 'New unlisted arena' : 'New unlisted room', exact: true })
        .click();
    const link = host.getByLabel('Room link', { exact: true });
    await expect(link).toHaveValue(/#rallar-room\?/);
    const roomId = toGroupId(await link.inputValue());
    await enterRoom(guest, roomId, game);
    if (game === 'arena') {
        await playTogetherInRoom(host, guest, game);
    }
    else {
        await playTogetherInRoom(guest, host, game);
        await guest.getByRole('button', { name: 'Submit Plan' }).click();
    }
    const moderation = host.getByRole('region', { name: 'Room moderation', exact: true });
    await expect(moderation.getByRole('button', { name: /^Ban / })).toBeEnabled();
    await moderation.getByRole('button', { name: /^Ban / }).click();
    await moderation.getByRole('button', { name: 'Cancel moderation', exact: true }).click();
    await expect(guest.getByRole('button', { name: game === 'arena' ? 'Leave arena' : 'Leave room', exact: true }))
        .toBeVisible();
    await moderation.getByRole('button', { name: /^Ban / }).click();
    await moderation.getByRole('button', { name: 'Confirm ban', exact: true }).click();
    await expect(moderation.getByRole('status')).toContainText('was banned');
    await expect(guest.getByRole('region', { name: 'Room moderation', exact: true }).getByRole('alert')).toContainText(
        'You were banned'
    );
    await expect(guest.getByRole('button', { name: game === 'arena' ? 'Leave arena' : 'Leave room', exact: true }))
        .toHaveCount(0);
    await continueAfterBan(host, guest, game);
    await guest.getByLabel('Room reference', { exact: true }).fill(roomId);
    await guest.getByRole('button', { name: 'Enter room', exact: true }).click();
    await expect(guest.getByText('Room entry was denied.', { exact: false })).toBeVisible();
    await moderation.getByRole('button', { name: /^Unban / }).click();
    await moderation.getByRole('button', { name: 'Confirm unban', exact: true }).click();
    await expect(moderation.getByRole('status')).toContainText('must join again');
    await expect(guest.getByRole('button', { name: game === 'arena' ? 'Leave arena' : 'Leave room', exact: true }))
        .toHaveCount(0);
    await enterRoom(guest, roomId, game);
    await moderation.getByRole('button', { name: /^Remove / }).click();
    await moderation.getByRole('button', { name: 'Confirm remove', exact: true }).click();
    await expect(guest.getByRole('region', { name: 'Room moderation', exact: true }).getByRole('alert')).toContainText(
        'You were removed'
    );
    await guest.getByRole('button', {
        name: game === 'arena' ? 'New unlisted arena' : 'New unlisted room',
        exact: true
    }).click();
    await expect(guest.getByLabel('Room link', { exact: true })).toHaveValue(/#rallar-room\?/);
    expect(toGroupId(await guest.getByLabel('Room link', { exact: true }).inputValue())).not.toBe(roomId);
    await expect(link).toHaveValue(new RegExp(roomId));
}

async function enterRoom(page: Page, roomId: string, game: 'arena' | 'relic'): Promise<void> {
    await page.getByLabel('Room reference', { exact: true }).fill(roomId);
    await page.getByRole('button', { name: 'Enter room', exact: true }).click();
    await expect(page.getByRole('button', { name: game === 'arena' ? 'Leave arena' : 'Leave room', exact: true }))
        .toBeVisible();
}

async function continueAfterBan(host: Page, guest: Page, game: 'arena' | 'relic'): Promise<void> {
    if (game === 'arena') {
        await expect(host.locator('.match-panel strong')).toHaveText(/^[01]:\d{2}$/);
        await expect(guest.getByRole('button', { name: 'Appoint this SPA', exact: true })).toBeDisabled();
        return;
    }
    await expect(guest.getByRole('button', { name: 'Submit Plan' })).toHaveCount(0);
    const takeover = host.getByRole('button', { name: 'Take over as Keeper', exact: true });
    await expect(takeover).toBeEnabled();
    await takeover.click();
    await expect(takeover).toHaveCount(0);
    await host.getByRole('button', { name: 'Submit Plan' }).click();
    await expect(host.locator('.turn-plan-status .panel-label')).toHaveText('Round 3', { timeout: 30000 });
}
