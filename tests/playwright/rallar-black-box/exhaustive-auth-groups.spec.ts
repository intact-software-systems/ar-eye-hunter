import { expect, type Locator, test } from '@playwright/test';
import {
  cleanupRallarPage,
  expectFullStackApiReady,
  expectNoSecrets,
  installExhaustiveRequestClientKey,
  loginUser,
  openTab,
  readBrowserAuthSession,
  readExhaustivePostgresConfig,
  uniqueGroupId,
} from './full-stack-helpers.ts';

const config = readExhaustivePostgresConfig();

test.describe('exhaustive auth and groups clients', () => {
  test.skip(!config.enabled, config.skipReason);

  test('covers bad login, good login, WS ticket, restore, and logout', async ({
    page,
    request,
  }, testInfo) => {
    await expectFullStackApiReady(request, config);
    const groupId = uniqueGroupId(testInfo);
    await installExhaustiveRequestClientKey(page, config, `${groupId}-auth-login`);
    const loginQuery = new URLSearchParams({
      provider: 'browser-rallar',
      apiBaseUrl: config.apiBaseUrl,
      roomId: groupId,
      tab: 'auth',
    });

    await page.goto(`/?${loginQuery.toString()}`);
    await expect(page.getByRole('heading', { name: 'Rallar Server Login' })).toBeVisible();
    await page.getByLabel('API Base URL').fill(config.apiBaseUrl);
    await page.getByLabel('Username').fill(config.userA.username);
    await page.getByLabel('Password').fill(`${config.userA.password}-wrong`);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('.auth-panel')).toContainText(/failed|invalid|unauthorized/i);

    await page.getByLabel('Password').fill(config.userA.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('.run-header')).toContainText(config.userA.username, {
      timeout: 30_000,
    });
    await openTab(page, 'auth');

    const authPanel = page.locator('#panel-auth');
    await authPanel.getByRole('button', { name: 'Create WS ticket' }).click();
    await expect(authPanel).toContainText(/ticket|ws-ticket/i);
    await expect(authPanel).toContainText(/<redacted>|redacted/i);
    await expectNoSecrets(authPanel, [config.userA.password]);

    const authSession = await readBrowserAuthSession(page);
    await page.reload();
    await expect(page.locator('.run-header')).toContainText(authSession.username, {
      timeout: 30_000,
    });

    await authPanel.getByRole('button', { name: 'Logout' }).click();
    await expect(page.getByRole('heading', { name: 'Rallar Server Login' })).toBeVisible();
  });

  test('creates, joins, refreshes, filters, and exports group/client state', async ({
    page,
    request,
  }, testInfo) => {
    await expectFullStackApiReady(request, config);
    const groupId = uniqueGroupId(testInfo);

    try {
      await loginUser(page, config, config.userA, {
        groupId,
        sessionId: `${groupId}-groups-session`,
        tab: 'rooms-clients',
      });
      const authSession = await readBrowserAuthSession(page);
      const panel = page.locator('#panel-rooms-clients');

      await panel.getByLabel('Group', { exact: true }).fill(groupId);
      await panel.getByLabel('Principal / Client').fill(authSession.clientId);
      await panel.getByLabel('Session', { exact: true }).fill(authSession.sessionId);
      await panel.getByLabel('Timeout', { exact: true }).fill('30000');

      await runRoomsRestAction(panel, 'Create group');
      await runRoomsRestAction(panel, 'Read group');
      await runRoomsRestAction(panel, 'Join group');
      await runRoomsRestAction(panel, 'Connect group presence');
      await runRoomsRestAction(panel, 'Connect client presence');
      await runRoomsRestAction(panel, 'List group events page');
      await runRoomsRestAction(panel, 'List client events page');

      await panel.getByRole('button', { name: 'Refresh state', exact: true }).click();
      await expect(panel.locator('[role="status"]').first()).toContainText(
        /state requests completed|Refresh completed/i,
        { timeout: 45_000 },
      );
      await expect(panel.locator('.rooms-state-grid')).toContainText(groupId, {
        timeout: 30_000,
      });
      await expect(panel.locator('.rooms-state-grid')).toContainText(authSession.clientId);

      await panel.getByLabel('Groups with members').check();
      await panel.getByLabel('Online clients').check();
      await panel.getByLabel('Expected other client').fill(config.userB.clientId);
      await expect(panel.locator('[aria-label="Groups and clients filters"]')).toContainText(
        /groups.*clients/i,
      );

      await panel.getByRole('button', { name: 'Copy state recipe' }).click();
      await expectNoSecrets(panel, [config.userA.password]);
    } finally {
      await cleanupRallarPage(page);
    }
  });
});

async function runRoomsRestAction(panel: Locator, name: string): Promise<void> {
  const feedback = panel.locator('[role="status"]').first();
  await panel.getByRole('button', { name, exact: true }).click();
  await expect(feedback).toContainText(name, { timeout: 30_000 });
  await expect(feedback).toContainText(/Request completed|OK|Created|No Content/i, {
    timeout: 45_000,
  });
}
