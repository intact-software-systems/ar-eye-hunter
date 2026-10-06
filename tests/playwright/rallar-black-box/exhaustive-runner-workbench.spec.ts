import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeRecord } from '@shared-test/rallar-bb-test/runtime/decode-runtime-result-values.ts';

import { validateSchemaAuthoringText } from '../../../apps/rallar-black-box/src/schema-authoring.ts';

import {
    cleanupRallarPage,
    expectFullStackApiReady,
    expectNoSecrets,
    loginUser,
    openTab,
    readExhaustivePostgresConfig,
    uniqueGroupId
} from './full-stack-helpers.ts';

const config = readExhaustivePostgresConfig();
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ARTIFACT_FIXTURE_DIR = path.join(
    REPO_ROOT,
    'packages/shared-test/black-box-runner/fixtures/schema/v1/artifact-bundle'
);

test.describe('exhaustive runner workbench tabs', () => {
    test.skip(!config.enabled, config.skipReason);

    test('runs Manual Rallar actions, history, matrix exports, and cleanup', async ({
        page,
        request
    }, testInfo) => {
        test.setTimeout(150_000);
        await expectFullStackApiReady(request, config);
        const groupId = uniqueGroupId(testInfo);

        try {
            await loginUser(page, config, config.userA, {
                groupId,
                sessionId: `${groupId}-manual-session`,
                tab: 'manual-rallar',
                workspace: 'black-box-runner'
            });
            const panel = page.locator('#panel-manual-rallar');

            await panel.getByLabel('Group').fill(groupId);
            await panel.getByLabel('Connection').fill(`manual-${testInfo.workerIndex}`);
            await panel.getByLabel('Transport').selectOption('realtime');
            await panel.getByLabel('Payload JSON').fill(JSON.stringify(
                {
                    kind: 'exhaustive-manual-rallar',
                    groupId
                },
                null,
                2
            ));

            await panel.getByRole('button', { name: 'Configure group' }).click();
            await expect(panel.locator('.manual-action-list')).toContainText(/configure/i, {
                timeout: 30_000
            });
            await panel.getByRole('button', { name: 'Create and join group' }).click();
            await expect(panel.locator('.manual-action-list')).toContainText(/join|connect/i, {
                timeout: 45_000
            });
            await panel.getByRole('button', { name: 'Send payload' }).click();
            await expect(panel.locator('.manual-action-list')).toContainText(/send/i, {
                timeout: 45_000
            });

            await panel.getByRole('button', { name: 'Show Recipe' }).click();
            await expect(panel.locator('.manual-recipe-output')).toContainText('recipeId');
            await panel.getByRole('button', { name: 'Copy Recipe' }).click();
            await panel.getByRole('button', { name: 'Run Realtime Matrix' }).click();
            await expect(panel.locator('.manual-action-list')).toContainText(/matrix|realtime/i, {
                timeout: 60_000
            });
            await panel.getByRole('button', { name: 'Copy Matrix Recipe' }).click();
            await panel.getByRole('button', { name: 'Copy Negative Recipe' }).click();
            await panel.getByRole('button', { name: 'Close connections' }).click();
            await expectNoSecrets(panel, [config.userA.password]);
        }
        finally {
            await cleanupRallarPage(page);
        }
    });

    test('preserves Manual Rallar capture choices through direct Connect, export, reload, and reset', async ({
        page,
        request
    }, testInfo) => {
        await expectFullStackApiReady(request, config);
        const groupId = uniqueGroupId(testInfo);

        try {
            await loginUser(page, config, config.userA, {
                groupId,
                sessionId: `${groupId}-capture-session`,
                tab: 'manual-rallar',
                workspace: 'black-box-runner'
            });
            await openTab(page, 'rooms-clients', 'rallar');
            const roomsPanel = page.locator('#panel-rooms-clients');
            await roomsPanel.getByLabel('Group', { exact: true }).fill(groupId);
            const createPath = `/api/state/apps/${encodeURIComponent(config.applicationId)}/workspaces/${
                encodeURIComponent(config.workspaceId)
            }/groups/requests/`;
            const createResponsePromise = page.waitForResponse((response) => {
                const url = new URL(response.url());
                return response.request().method() === 'POST' &&
                    url.origin === config.apiBaseUrl &&
                    url.pathname.startsWith(createPath);
            });
            await roomsPanel.getByRole('button', { name: 'Create group', exact: true }).click();
            const createResponse = await createResponsePromise;
            expect([200, 201]).toContain(createResponse.status());
            await openTab(page, 'manual-rallar', 'black-box-runner');
            const panel = page.locator('#panel-manual-rallar');
            await expect(panel).toBeVisible();
            await expect(panel.getByLabel('Transport')).toBeVisible();
            await expect(panel.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled();
            const initialDraftText = await page.evaluate(() =>
                window.localStorage.getItem('rallar-black-box.ui.manual-draft.v1')
            );
            const initialDraft = decodeRecord(JSON.parse(initialDraftText ?? 'null'));
            expect(decodeRecord(initialDraft.values).rtcCaptureMode).toBeUndefined();

            const capture = panel.getByRole('combobox', { name: /RTC capture/i });
            await expect(capture).toBeVisible();
            await expect(capture.locator('option')).toHaveText(['Inherit', 'Off', 'Signaling', 'Full native']);
            await expect(capture).toHaveValue('');
            const current = panel.getByLabel('Current RTC capture');
            await expect(current).toBeVisible();

            await capture.selectOption('off');
            await panel.getByRole('button', { name: 'Connect', exact: true }).click();
            await expect(panel.locator('.manual-action-list')).toContainText(/connect/i);
            const connectResults = panel.locator('.history-row').filter({ hasText: 'rtc.connect' });
            await expect(connectResults).toHaveCount(1);
            await connectResults.first().click();
            await openTab(page, 'event-stream');
            const resultJson = page.locator('#panel-event-stream .focus-panel .json-block');
            await expect.poll(async () => decodeRecord(JSON.parse(await resultJson.textContent() ?? 'null')))
                .toMatchObject({
                    kind: 'rtc.connect',
                    ok: true,
                    value: {
                        rtcCapture: {
                            status: 'observed',
                            value: {
                                configuration: { mode: 'off' },
                                application: { status: 'applied', mode: 'off' },
                                connectionId: { status: 'observed', value: expect.stringMatching(/\S/) },
                                nativeScopeId: { status: 'unavailable', reason: 'not-applicable' },
                                nativeAvailability: { status: 'unavailable', reason: 'disabled' },
                                nativeCoverage: 'not-applicable'
                            }
                        }
                    }
                });
            await openTab(page, 'manual-rallar');
            await expect(current).toContainText(/\boff\b/i);
            await expect(current).toContainText(/\bapplied\b/i);
            await panel.getByRole('button', { name: 'Show Recipe' }).click();
            const firstExport = validateSchemaAuthoringText(
                'recipe',
                await panel.locator('.manual-recipe-output').inputValue()
            );
            expect(firstExport.ok).toBe(true);
            expect(firstExport.parsed).toMatchObject({
                commands: [{ kind: 'rtc.connect', rallar: { rtcCaptureMode: 'off' } }]
            });

            await expect(capture).toBeEnabled();
            const currentBeforeEdit = await current.textContent();
            await capture.selectOption('native');
            await expect(current).toHaveText(currentBeforeEdit ?? '');
            await panel.getByRole('button', { name: 'Close connections' }).click();
            await expect(panel.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled();
            await panel.getByRole('button', { name: 'Connect', exact: true }).click();
            await expect(connectResults).toHaveCount(2);
            await connectResults.first().click();
            await openTab(page, 'event-stream');
            await expect.poll(async () => decodeRecord(JSON.parse(await resultJson.textContent() ?? 'null')))
                .toMatchObject({
                    kind: 'rtc.connect',
                    ok: true,
                    value: {
                        rtcCapture: {
                            status: 'observed',
                            value: {
                                configuration: { mode: 'native' },
                                application: { status: 'applied', mode: 'native' },
                                connectionId: { status: 'observed', value: expect.stringMatching(/\S/) },
                                nativeScopeId: { status: 'observed', value: expect.stringMatching(/\S/) },
                                nativeAvailability: { status: 'observed', value: 'enabled' },
                                nativeCoverage: expect.stringMatching(/^(attached|partial)$/)
                            }
                        }
                    }
                });
            await openTab(page, 'manual-rallar');
            await expect(current).toContainText(/\bnative\b/i);
            await expect(current).toContainText(/\bapplied\b/i);
            await expect(capture).toBeEnabled();
            await capture.selectOption('signaling');
            const retainedExport = validateSchemaAuthoringText(
                'recipe',
                await panel.locator('.manual-recipe-output').inputValue()
            );
            expect(retainedExport.ok).toBe(true);
            expect(retainedExport.parsed).toMatchObject({
                commands: expect.arrayContaining([
                    expect.objectContaining({
                        kind: 'rtc.connect',
                        rallar: expect.objectContaining({ rtcCaptureMode: 'off' })
                    }),
                    expect.objectContaining({
                        kind: 'rtc.connect',
                        rallar: expect.objectContaining({ rtcCaptureMode: 'native' })
                    })
                ])
            });

            await page.reload();
            await expect(capture).toHaveValue('signaling');
            await panel.getByRole('button', { name: 'Reset runtime', exact: true }).click();
            await expect.poll(async () => {
                const text = await page.evaluate(() =>
                    window.localStorage.getItem('rallar-black-box.ui.manual-draft.v1')
                );
                const stored = decodeRecord(JSON.parse(text ?? 'null'));
                return decodeRecord(stored.values).rtcCaptureMode;
            }).toBeUndefined();
            await expectNoSecrets(panel, [config.userA.password]);
        }
        finally {
            await cleanupRallarPage(page);
        }
    });

    test('loads and runs Local Workbench recipes with queue report and reset evidence', async ({
        page,
        request
    }, testInfo) => {
        await expectFullStackApiReady(request, config);
        const groupId = uniqueGroupId(testInfo);

        try {
            await loginUser(page, config, config.userA, {
                groupId,
                sessionId: `${groupId}-workbench-session`,
                tab: 'local-workbench',
                workspace: 'black-box-runner'
            });
            const panel = page.locator('#panel-local-workbench');

            await panel.getByRole('button', { name: 'Load' }).click();
            await expect(panel).toContainText(/loaded|Recipe JSON|valid/i, { timeout: 30_000 });
            await panel.getByRole('button', { name: 'Run' }).click();
            await expect(panel).toContainText(/completed|Command Queue|Completed Commands|Report/i, {
                timeout: 60_000
            });
            await panel.getByRole('button', { name: 'Cancel' }).click();
            await panel.getByRole('button', { name: 'Reset' }).click();
            await expect(panel).toContainText(/idle|pending|No commands/i, { timeout: 30_000 });
        }
        finally {
            await cleanupRallarPage(page);
        }
    });

    test('builds and runs Flow Builder recipes and copies exports', async ({
        page,
        request
    }, testInfo) => {
        await expectFullStackApiReady(request, config);
        const groupId = uniqueGroupId(testInfo);

        try {
            await loginUser(page, config, config.userA, {
                groupId,
                sessionId: `${groupId}-flow-session`,
                tab: 'flow-builder',
                workspace: 'black-box-runner'
            });
            const panel = page.locator('#panel-flow-builder');

            await panel.getByLabel('Variables JSON').fill(JSON.stringify(
                {
                    apiBaseUrl: config.apiBaseUrl,
                    applicationId: config.applicationId,
                    workspaceId: config.workspaceId,
                    groupId,
                    roomId: groupId
                },
                null,
                2
            ));
            await panel.getByRole('button', { name: 'Add rest.request' }).click();
            await panel.getByRole('button', { name: 'Add wait' }).click();
            await panel.getByRole('button', { name: 'Normalize JSON' }).click();
            await expect(panel).toContainText(/SPA Recipe Preview|Runner Scenario Preview|commands/i);
            await panel.getByRole('button', { name: 'Run Flow' }).click();
            await expect(panel).toContainText(/flow-builder-run|completed|failed/i, {
                timeout: 60_000
            });
            await panel.getByRole('button', { name: 'Copy SPA Recipe' }).click();
            await panel.getByRole('button', { name: 'Copy Runner Scenario' }).click();
            await expectNoSecrets(panel, [config.userA.password]);
        }
        finally {
            await cleanupRallarPage(page);
        }
    });

    test('shows Shared Test catalog and imports valid and invalid artifacts', async ({
        page,
        request
    }, testInfo) => {
        await expectFullStackApiReady(request, config);
        const groupId = uniqueGroupId(testInfo);

        try {
            await loginUser(page, config, config.userA, {
                groupId,
                sessionId: `${groupId}-shared-session`,
                tab: 'shared-test',
                workspace: 'black-box-runner'
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
                path.join(ARTIFACT_FIXTURE_DIR, 'matrix-summary.json')
            ]);
            await expect(panel).toContainText(/Imported Summary|valid|Event Stream/i, {
                timeout: 30_000
            });

            await panel.locator('input[type="file"]').setInputFiles({
                name: 'metadata.json',
                mimeType: 'application/json',
                buffer: Buffer.from(JSON.stringify({ not: 'a valid artifact bundle' }))
            });
            await expect(panel).toContainText(/invalid|error|missing/i, { timeout: 30_000 });
            await expectNoSecrets(panel, [config.userA.password]);
        }
        finally {
            await cleanupRallarPage(page);
        }
    });
});
