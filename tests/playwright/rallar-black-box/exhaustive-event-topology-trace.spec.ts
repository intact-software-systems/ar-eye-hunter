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

test.describe('exhaustive events topology trace and diagnostics', () => {
  test.skip(!config.enabled, config.skipReason);

  test('filters event stream trace diagnostics and topology after live activity', async ({
    page,
    request,
  }, testInfo) => {
    await expectFullStackApiReady(request, config);
    const groupId = uniqueGroupId(testInfo);

    try {
      await loginUser(page, config, config.userA, {
        groupId,
        sessionId: `${groupId}-events-session`,
        tab: 'quick-test',
      });

      const quick = page.getByLabel('Rallar Quick Test');
      await quick.getByLabel('Timeout', { exact: true }).fill('60000');
      await quick.getByRole('button', { name: 'Create and join group' }).click();
      await expect(quick).toContainText(/completed|created|joined/i, { timeout: 75_000 });
      await quick.getByRole('button', { name: 'Subscribe WS', exact: true }).click();
      await expect(quick.getByLabel('Quick Test received messages')).toContainText('Listening', {
        timeout: 30_000,
      });
      await quick.getByLabel('Payload JSON').fill(JSON.stringify({
        kind: 'exhaustive-event-evidence',
        groupId,
      }, null, 2));
      await quick.getByRole('button', { name: 'Send WS JSON' }).click();
      await expect(quick).toContainText(/sent|completed|Quick Test WS JSON/i, {
        timeout: 45_000,
      });

      await openTab(page, 'event-stream');
      const eventPanel = page.locator('#panel-event-stream');
      await eventPanel.getByRole('button', { name: 'message' }).click();
      await eventPanel.getByLabel('Topic').fill('rallar');
      await eventPanel.getByLabel('Window').selectOption('40');
      await expect(eventPanel).toContainText(/visible|rallar|message/i);
      await eventPanel.getByRole('button', { name: 'all' }).click();
      await eventPanel.getByLabel('Group').selectOption(groupId).catch(() => undefined);
      await expectNoSecrets(eventPanel, [config.userA.password]);

      await openTab(page, 'rallar-trace');
      const tracePanel = page.locator('#panel-rallar-trace');
      await tracePanel.getByLabel('Source').selectOption('direct');
      await tracePanel.getByLabel('Severity').selectOption('info');
      await tracePanel.getByLabel('Window').selectOption('50');
      await expect(tracePanel).toContainText(/Events|direct|rallar\.direct/i, {
        timeout: 30_000,
      });
      await tracePanel.getByLabel('Source').selectOption('all');
      await expectNoSecrets(tracePanel, [config.userA.password]);

      await openTab(page, 'rtc-diagnostics');
      const rtcPanel = page.locator('#panel-rtc-diagnostics');
      await rtcPanel.getByRole('button', { name: 'Health' }).click();
      await expect(rtcPanel).toContainText(/RTC Diagnostics|Lane Health|First payload|NACK/i, {
        timeout: 45_000,
      });
      await rtcPanel.getByRole('button', { name: 'Show Bundle' }).click();
      await expect(rtcPanel.locator('.rtc-bundle-output')).toContainText(/stages|membership/i);
      await rtcPanel.getByRole('button', { name: 'Copy Bundle' }).click();
      await expectNoSecrets(rtcPanel, [config.userA.password]);

      await openTab(page, 'topology');
      const topologyPanel = page.locator('#panel-topology');
      await expect(topologyPanel).toContainText(/nodes|Edges|Rooms|Routes/i);
      await topologyPanel.getByLabel('Search').fill(groupId);
      await expect(topologyPanel.getByLabel('Search')).toHaveValue(groupId);
      await expect(topologyPanel).toContainText(/Nodes\s*1 of 1|room -/i, {
        timeout: 30_000,
      });
      await topologyPanel.getByLabel('Node Limit').selectOption('50');
      await topologyPanel.getByRole('button', { name: 'active' }).click();
      await expect(topologyPanel).toContainText(/Visible Nodes|Routes|nodes/i);
      await topologyPanel.getByRole('button', { name: 'All' }).click();
    } finally {
      await cleanupRallarPage(page);
    }
  });
});
