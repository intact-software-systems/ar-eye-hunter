import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ARTIFACT_FIXTURE_DIR = path.join(
  REPO_ROOT,
  'packages/shared-test/black-box-runner/fixtures/schema/v1/artifact-bundle',
);

test.describe('exhaustive runner workbench tabs', () => {
  test.skip(!config.enabled, config.skipReason);

  test('runs Manual Rallar actions, history, matrix exports, and cleanup', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(150_000);
    await expectFullStackApiReady(request, config);
    const groupId = uniqueGroupId(testInfo);

    try {
      await loginUser(page, config, config.userA, {
        groupId,
        sessionId: `${groupId}-manual-session`,
        tab: 'manual-rallar',
        workspace: 'black-box-runner',
      });
      const panel = page.locator('#panel-manual-rallar');

      await panel.getByLabel('Group').fill(groupId);
      await panel.getByLabel('Connection').fill(`manual-${testInfo.workerIndex}`);
      await panel.getByLabel('Transport').selectOption('realtime');
      await panel.getByLabel('Payload JSON').fill(JSON.stringify({
        kind: 'exhaustive-manual-rallar',
        groupId,
      }, null, 2));

      await panel.getByRole('button', { name: 'Configure group' }).click();
      await expect(panel.locator('.manual-action-list')).toContainText(/configure/i, {
        timeout: 30_000,
      });
      await panel.getByRole('button', { name: 'Create and join group' }).click();
      await expect(panel.locator('.manual-action-list')).toContainText(/join|connect/i, {
        timeout: 45_000,
      });
      await panel.getByRole('button', { name: 'Send payload' }).click();
      await expect(panel.locator('.manual-action-list')).toContainText(/send/i, {
        timeout: 45_000,
      });

      await panel.getByRole('button', { name: 'Show Recipe' }).click();
      await expect(panel.locator('.manual-recipe-output')).toContainText('recipeId');
      await panel.getByRole('button', { name: 'Copy Recipe' }).click();
      await panel.getByRole('button', { name: 'Run Realtime Matrix' }).click();
      await expect(panel.locator('.manual-action-list')).toContainText(/matrix|realtime/i, {
        timeout: 60_000,
      });
      await panel.getByRole('button', { name: 'Copy Matrix Recipe' }).click();
      await panel.getByRole('button', { name: 'Copy Negative Recipe' }).click();
      await panel.getByRole('button', { name: 'Close connections' }).click();
      await expectNoSecrets(panel, [config.userA.password]);
    } finally {
      await cleanupRallarPage(page);
    }
  });

  test('loads and runs Local Workbench recipes with queue report and reset evidence', async ({
    page,
    request,
  }, testInfo) => {
    await expectFullStackApiReady(request, config);
    const groupId = uniqueGroupId(testInfo);

    try {
      await loginUser(page, config, config.userA, {
        groupId,
        sessionId: `${groupId}-workbench-session`,
        tab: 'local-workbench',
        workspace: 'black-box-runner',
      });
      const panel = page.locator('#panel-local-workbench');

      await panel.getByRole('button', { name: 'Load' }).click();
      await expect(panel).toContainText(/loaded|Recipe JSON|valid/i, { timeout: 30_000 });
      await panel.getByRole('button', { name: 'Run' }).click();
      await expect(panel).toContainText(/completed|Command Queue|Completed Commands|Report/i, {
        timeout: 60_000,
      });
      await panel.getByRole('button', { name: 'Cancel' }).click();
      await panel.getByRole('button', { name: 'Reset' }).click();
      await expect(panel).toContainText(/idle|pending|No commands/i, { timeout: 30_000 });
    } finally {
      await cleanupRallarPage(page);
    }
  });

  test('builds and runs Flow Builder recipes and copies exports', async ({
    page,
    request,
  }, testInfo) => {
    await expectFullStackApiReady(request, config);
    const groupId = uniqueGroupId(testInfo);

    try {
      await loginUser(page, config, config.userA, {
        groupId,
        sessionId: `${groupId}-flow-session`,
        tab: 'flow-builder',
        workspace: 'black-box-runner',
      });
      const panel = page.locator('#panel-flow-builder');

      await panel.getByLabel('Variables JSON').fill(JSON.stringify({
        apiBaseUrl: config.apiBaseUrl,
        applicationId: config.applicationId,
        workspaceId: config.workspaceId,
        groupId,
        roomId: groupId,
      }, null, 2));
      await panel.getByRole('button', { name: 'Add rest.request' }).click();
      await panel.getByRole('button', { name: 'Add wait' }).click();
      await panel.getByRole('button', { name: 'Normalize JSON' }).click();
      await expect(panel).toContainText(/SPA Recipe Preview|Runner Scenario Preview|commands/i);
      await panel.getByRole('button', { name: 'Run Flow' }).click();
      await expect(panel).toContainText(/flow-builder-run|completed|failed/i, {
        timeout: 60_000,
      });
      await panel.getByRole('button', { name: 'Copy SPA Recipe' }).click();
      await panel.getByRole('button', { name: 'Copy Runner Scenario' }).click();
      await expectNoSecrets(panel, [config.userA.password]);
    } finally {
      await cleanupRallarPage(page);
    }
  });

  test('shows Shared Test catalog and imports valid and invalid artifacts', async ({
    page,
    request,
  }, testInfo) => {
    await expectFullStackApiReady(request, config);
    const groupId = uniqueGroupId(testInfo);

    try {
      await loginUser(page, config, config.userA, {
        groupId,
        sessionId: `${groupId}-shared-session`,
        tab: 'shared-test',
        workspace: 'black-box-runner',
      });
      const panel = page.locator('#panel-shared-test');

      await expect(panel).toContainText(/Recipe Catalog|artifact|runner/i);
      await panel.getByLabel('Search', { exact: true }).fill('auth');
      await expect(panel).toContainText(/auth|visible/i);
      await panel.getByRole('button', { name: /Copy .*command|Copy Command|Copy Runner/i })
        .first()
        .click();

      await panel.locator('input[type="file"]').setInputFiles([
        path.join(ARTIFACT_FIXTURE_DIR, 'report.json'),
        path.join(ARTIFACT_FIXTURE_DIR, 'events.jsonl'),
        path.join(ARTIFACT_FIXTURE_DIR, 'failures.json'),
        path.join(ARTIFACT_FIXTURE_DIR, 'metadata.json'),
        path.join(ARTIFACT_FIXTURE_DIR, 'artifact-index.json'),
        path.join(ARTIFACT_FIXTURE_DIR, 'expanded-recipe.json'),
        path.join(ARTIFACT_FIXTURE_DIR, 'expanded-plan.json'),
        path.join(ARTIFACT_FIXTURE_DIR, 'reduced-plan.json'),
        path.join(ARTIFACT_FIXTURE_DIR, 'matrix-summary.json'),
      ]);
      await expect(panel).toContainText(/Imported Summary|valid|Event Stream/i, {
        timeout: 30_000,
      });

      await panel.locator('input[type="file"]').setInputFiles({
        name: 'metadata.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify({ not: 'a valid artifact bundle' })),
      });
      await expect(panel).toContainText(/invalid|error|missing/i, { timeout: 30_000 });
      await expectNoSecrets(panel, [config.userA.password]);
    } finally {
      await cleanupRallarPage(page);
    }
  });
});
