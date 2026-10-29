import { expect, type Page } from '@playwright/test';

export interface RelicBrowserCredentials {
    readonly username: string;
    readonly password: string;
}

export async function registerRelicHunter(page: Page, role: string): Promise<RelicBrowserCredentials> {
    const suffix = crypto.randomUUID();
    const credentials = { username: `relic-${role}-${suffix}`, password: `relic-test-${suffix}` };
    await page.goto('/');
    await page.getByRole('button', { name: 'Register', exact: true }).click();
    await page.getByLabel('Username', { exact: true }).fill(credentials.username);
    await page.getByLabel('Display name', { exact: true }).fill(role);
    await page.getByLabel('Password', { exact: true }).fill(credentials.password);
    await page.getByRole('button', { name: 'Create Hunter', exact: true }).click();
    await expect(page.getByRole('button', { name: 'New Room', exact: true })).toBeEnabled();
    return credentials;
}

export async function waitForExpeditionScene(page: Page): Promise<void> {
    // A new Babylon context can block browser tasks while portable SwiftShader initializes.
    // Require the actual expedition frame before testing the room's visible participation state.
    await expect(page.locator('canvas.relic-scene[data-scene-runtime="next"]'))
        .toHaveAttribute('data-scene-ready', 'true', { timeout: 30_000 });
}
