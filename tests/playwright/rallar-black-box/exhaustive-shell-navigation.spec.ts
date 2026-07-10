import { expect, test } from '@playwright/test';
import {
  cleanupRallarPage,
  expectFullStackApiReady,
  expectNoSecrets,
  loginUser,
  openTab,
  readExhaustivePostgresConfig,
  uniqueGroupId,
} from './full-stack-helpers.ts';

const config = readExhaustivePostgresConfig();

test.describe('exhaustive shell navigation and persistence', () => {
  test.skip(!config.enabled, config.skipReason);

  test('covers workspace switching, Global Context, trace, and redacted persistence', async ({
    page,
    request,
  }, testInfo) => {
    await expectFullStackApiReady(request, config);
    const groupId = uniqueGroupId(testInfo);

    try {
      await loginUser(page, config, config.userA, {
        groupId,
        sessionId: `${groupId}-session`,
        tab: 'quick-test',
      });

      await expect(page.getByRole('tab', { name: 'Quick Test' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(page.getByLabel('Global Room')).toHaveValue(groupId);
      await expect(page.locator('[aria-label="Rallar browser trace"]').first())
        .toContainText('Rallar mode');
      await expect(page.locator('.rallar-trace-summary')).toBeHidden();
      const quickBeforeTrace = await page.evaluate(() => {
        const quick = document.querySelector('#panel-quick-test');
        const trace = document.querySelector('[aria-label="Rallar browser trace"]');
        return Boolean(
          quick &&
            trace &&
            (quick.compareDocumentPosition(trace) & Node.DOCUMENT_POSITION_FOLLOWING),
        );
      });
      expect(quickBeforeTrace).toBe(true);
      await expect(page.getByLabel('Direct Rallar operation boundary')).toContainText(
        'Direct Rallar Operations',
      );

      await page.getByLabel('Rallar workspace mode')
        .getByRole('button', { name: /Rallar black-box-runner/ })
        .click();
      await expect(page.getByRole('tab', { name: 'Recipes', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(page.getByLabel('Runner mode boundary')).toContainText('Runner Workspace');
      await expect(page.getByRole('tab', { name: 'Quick Test' })).toHaveCount(0);

      await openTab(page, 'manual-rallar', 'black-box-runner');
      await expect(page.getByRole('tab', { name: 'Advanced' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(page.locator('#panel-advanced')).toContainText('Manual Rallar');
      await page.locator('#panel-advanced').getByLabel('Group').fill(groupId);
      await openTab(page, 'event-stream', 'black-box-runner');
      await page
        .locator('#panel-event-stream')
        .getByRole('button', { name: 'message', exact: true })
        .click();

      const reloadQuery = new URLSearchParams({
        provider: 'browser-rallar',
        experience: 'legacy',
        apiBaseUrl: config.apiBaseUrl,
        applicationId: config.applicationId,
        workspaceId: config.workspaceId,
        roomId: groupId,
      });
      await page.goto(`/?${reloadQuery.toString()}`);
      await expect(page.getByRole('tab', { name: 'Event Stream' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(page
        .locator('#panel-event-stream')
        .getByRole('button', { name: 'message', exact: true }))
        .toHaveClass(/selected/);

      const storageText = await page.evaluate(() => JSON.stringify({
        localStorage: { ...window.localStorage },
        sessionStorage: { ...window.sessionStorage },
      }));
      expect(storageText).not.toContain(config.userA.password);
      await expectNoSecrets(page.locator('body'), [config.userA.password]);
    } finally {
      await cleanupRallarPage(page);
    }
  });

  test('keeps mobile header, context, trace, and collapsible panels usable', async ({
    page,
    request,
  }, testInfo) => {
    await expectFullStackApiReady(request, config);
    await page.setViewportSize({ width: 430, height: 932 });
    const groupId = uniqueGroupId(testInfo);

    try {
      await loginUser(page, config, config.userA, {
        groupId,
        sessionId: `${groupId}-mobile-session`,
        tab: 'quick-test',
      });

      await page.getByRole('button', { name: 'Show details' }).click();
      await expect(page.locator('.run-header')).toContainText(config.userA.username);
      await page.getByRole('button', { name: 'Hide details' }).click();

      await page.getByRole('button', { name: 'Show values' }).click();
      await expect(page.getByLabel('Global Room')).toHaveValue(groupId);
      await page.getByRole('button', { name: 'Hide values' }).click();

      await page.getByRole('button', { name: 'Show Rallar Browser Trace' }).click();
      await expect(page.locator('.rallar-trace-summary')).toBeVisible();
      await page.getByRole('button', { name: 'Hide Rallar Browser Trace' }).click();
      await expect(page.locator('.rallar-trace-summary')).toBeHidden();

      await page.getByRole('button', { name: 'Hide Quick Test Inputs' }).click();
      await expect(page.locator('.quick-rallar-context-grid')).toBeHidden();
      await page.getByRole('button', { name: 'Show Quick Test Inputs' }).click();
      await expect(page.locator('.quick-rallar-context-grid')).toBeVisible();
    } finally {
      await cleanupRallarPage(page);
    }
  });
});
