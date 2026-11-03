import { expect, type Page } from '@playwright/test';

/** Only visible plan buttons earn the score; the browser never supplies a result. */
export async function playRelicTournament(winner: Page, opponent: Page): Promise<void> {
    await expectRound([winner, opponent], 1);
    await winner.locator('.action-picker').getByRole('button', { name: /^Search/ }).click();
    await submitPlans(winner, opponent);
    await expectRound([winner, opponent], 2);
    await expect(winner.locator('.relic-inventory')).toContainText('Visitor Badge');
    await opponent.reload();
    await expectRound([opponent], 2);
    for (const [index, destination] of ['Hallway', 'Trap Room', 'Monster Lair', 'Exit'].entries()) {
        for (const player of [winner, opponent]) {
            await player.locator('.action-picker').getByRole('button', { name: /^Move/ }).click();
            await player.locator('.target-choice-grid').getByRole('button', {
                name: new RegExp(`^${destination}`)
            }).click();
        }
        await submitPlans(winner, opponent);
        await expectRound([winner, opponent], index + 3);
    }
    for (const player of [winner, opponent]) {
        await player.locator('.action-picker').getByRole('button', { name: /^Escape/ }).click();
    }
    await submitPlans(winner, opponent);
    for (const player of [winner, opponent]) {
        await expect(player.locator('.victory-panel')).toBeVisible({ timeout: 30000 });
        await expect(player.locator('.final-score-tag.success')).toHaveText(['escaped', 'escaped']);
        await expect(player.locator('.final-score-row').first()).toContainText('Visitor Badge');
        await expect(player.locator('.final-score-value')).toHaveText(['6', '5']);
    }
    await expect(opponent.locator('.victory-panel h2')).toHaveText(
        await winner.locator('.victory-panel h2').innerText()
    );
}

async function submitPlans(first: Page, second: Page): Promise<void> {
    await first.getByRole('button', { name: /^Submit Plan/ }).click();
    await second.getByRole('button', { name: /^Submit Plan/ }).click();
}

async function expectRound(players: readonly Page[], round: number): Promise<void> {
    for (const player of players) {
        await expect(player.locator('.turn-plan-status .panel-label')).toHaveText(`Round ${round}`, { timeout: 30000 });
        await expect(player.getByRole('button', { name: /^Submit Plan/ })).toBeEnabled();
    }
}
