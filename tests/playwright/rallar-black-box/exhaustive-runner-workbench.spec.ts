import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestResult
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { decodeNonBlankText, decodeRecord } from '@shared-test/rallar-bb-test/runtime/decode-runtime-result-values.ts';

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

test('preserves loaded Local recipe intent through capture choices and experience remount', async ({ page }) => {
    await page.goto('/?provider=simulated&experience=legacy&workspace=black-box-runner&tab=local-workbench');
    const panel = page.locator('#panel-local-workbench');
    await expect(panel.locator('.workbench-panel .panel-heading .pill')).toHaveText('passed');
    await panel.getByRole('combobox', { name: 'Fixture', exact: true }).selectOption('ws-http-smoke');
    await panel.getByRole('button', { name: 'Load', exact: true }).click();
    await expect.poll(() =>
        page.evaluate(async () => {
            const modulePath = '/src/runtime-store.ts';
            const { rallarBlackBoxRuntimeStore } = await import(modulePath);
            return rallarBlackBoxRuntimeStore.getSnapshot();
        })
    ).toMatchObject({
        loadedFixtureId: 'ws-http-smoke',
        state: { loadedRecipe: { schemaVersion: 1, recipeId: 'ws-http-smoke-recipe' } }
    });

    const recipe = {
        schemaVersion: 1,
        recipeId: 'ws-http-smoke-recipe',
        rtcCaptureMode: 'native',
        commands: [{
            kind: 'rtc.connect',
            commandId: 'authored-off-connect',
            connection: 'local-capture-choice',
            actor: 'local-capture-actor',
            rallar: { rtcCaptureMode: 'off' }
        }]
    } satisfies RallarBlackBoxTestRecipe;
    const recipeText = JSON.stringify(recipe, null, 2);
    const editor = panel.getByRole('textbox', { name: 'Recipe JSON', exact: true });
    await editor.fill(recipeText);
    await panel.getByRole('button', { name: 'Load', exact: true }).click();
    await expect.poll(() =>
        page.evaluate(async () => {
            const modulePath = '/src/runtime-store.ts';
            const { rallarBlackBoxRuntimeStore } = await import(modulePath);
            return rallarBlackBoxRuntimeStore.getSnapshot().state.loadedRecipe;
        })
    ).toEqual(recipe);
    expect(
        await page.evaluate(async () => {
            const modulePath = '/src/runtime-store.ts';
            const { rallarBlackBoxRuntimeStore } = await import(modulePath);
            return rallarBlackBoxRuntimeStore.getSnapshot().loadedFixtureId;
        })
    ).toBeUndefined();
    await expect(editor).toHaveValue(recipeText);

    const capture = panel.getByRole('combobox', { name: /RTC capture/i });
    await expect(capture).toBeVisible();
    await expect(capture.locator('option')).toHaveText(['Inherit', 'Off', 'Signaling', 'Full native']);
    await expect(capture).toHaveValue('');
    await capture.selectOption('off');
    await expect(editor).toHaveValue(recipeText);
    const invocations: string[] = [];
    for (const choice of ['off', 'signaling', 'native', '']) {
        await capture.selectOption(choice);
        await panel.getByRole('button', { name: 'Run', exact: true }).click();
        await expect(panel.locator('.workbench-panel .panel-heading .pill')).toHaveText('passed');
        const latest = await page.evaluate(async () => {
            const modulePath = '/src/runtime-store.ts';
            const { rallarBlackBoxRuntimeStore } = await import(modulePath);
            return rallarBlackBoxRuntimeStore.getSnapshot().state.commandHistory
                .filter((result: RallarBlackBoxTestResult) => result.kind === 'recipe.run').at(-1);
        });
        expect(latest?.ok).toBe(true);
        expect(latest?.replayed).not.toBe(true);
        const invocation = decodeRecord(decodeRecord(latest?.value).invocation);
        expect(invocation.run).toBe(choice === '' ? undefined : choice);
        expect(invocation.recipe).toBe('native');
        const invocationId = decodeNonBlankText(invocation.invocationId);
        if (invocationId === undefined) {
            throw new Error('The local recipe run did not publish an invocation identity.');
        }
        expect(invocations).not.toContain(invocationId);
        invocations.push(invocationId);
        await expect(editor).toHaveValue(recipeText);
        expect(
            await page.evaluate(async () => {
                const modulePath = '/src/runtime-store.ts';
                const { rallarBlackBoxRuntimeStore } = await import(modulePath);
                return rallarBlackBoxRuntimeStore.getSnapshot().state.loadedRecipe;
            })
        ).toEqual(recipe);
    }

    await page.evaluate(() => {
        const url = new URL(window.location.href);
        url.searchParams.set('experience', 'recipe-console');
        window.history.pushState({}, '', url);
        window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.locator('.recipe-console')).toBeVisible();
    await expect(panel).toHaveCount(0);

    await page.goBack();
    await expect(panel).toBeVisible();
    await expect(page.locator('.recipe-console')).toHaveCount(0);
    expect(
        await page.evaluate(async () => {
            const modulePath = '/src/runtime-store.ts';
            const { rallarBlackBoxRuntimeStore } = await import(modulePath);
            return rallarBlackBoxRuntimeStore.getSnapshot().state.loadedRecipe;
        })
    ).toEqual(recipe);
    await expect(editor).toHaveValue(recipeText);

    const unsubmittedText = JSON.stringify({ ...recipe, recipeId: 'unsubmitted-local-draft' }, null, 2);
    await editor.fill(unsubmittedText);
    await page.locator('.run-header').getByRole('button', { name: 'Show details', exact: true }).click();
    await page.evaluate(async () => {
        const modulePath = '/src/runtime-store.ts';
        const { rallarBlackBoxRuntimeStore } = await import(modulePath);
        rallarBlackBoxRuntimeStore.recordRuntimeEvent({
            kind: 'diagnostic',
            topic: 'rallar.browser.workbench.draft-preservation',
            severity: 'info',
            payload: {}
        }, 'Unsubmitted draft preservation check');
    });
    await expect(page.getByText('Unsubmitted draft preservation check', { exact: true })).toBeVisible();
    await expect(editor).toHaveValue(unsubmittedText);

    await panel.getByRole('button', { name: 'Reset', exact: true }).click();
    await expect.poll(() =>
        page.evaluate(async () => {
            const modulePath = '/src/runtime-store.ts';
            const { rallarBlackBoxRuntimeStore } = await import(modulePath);
            return rallarBlackBoxRuntimeStore.getSnapshot().state.loadedRecipe;
        })
    ).toBeUndefined();
    await page.evaluate(() => {
        const url = new URL(window.location.href);
        url.searchParams.set('experience', 'recipe-console');
        window.history.pushState({}, '', url);
        window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.locator('.recipe-console')).toBeVisible();
    await expect(panel).toHaveCount(0);
    await page.goBack();
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('combobox', { name: 'Fixture', exact: true }))
        .toHaveValue('rtc-messages-principal-multicast-sender');
    expect(decodeRecord(JSON.parse(await editor.inputValue())).recipeId)
        .toBe('rtc-messages-principal-multicast-sender');
});

test('preserves copied Manual history through Local Load, run choices, and experience remount', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/?provider=simulated&experience=legacy&workspace=black-box-runner&tab=manual-rallar');
    const manual = page.locator('#panel-manual-rallar');
    await expect(manual.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled();
    await page.getByRole('textbox', { name: 'Global Application', exact: true }).fill('copy-local-app');
    await page.getByRole('textbox', { name: 'Global Workspace', exact: true }).fill('copy-local-workspace');
    await page.getByRole('textbox', { name: 'Global Room', exact: true }).fill('copy-local-group');
    await page.getByRole('textbox', { name: 'Global Client', exact: true }).fill('copy-local-actor');
    await page.getByRole('textbox', { name: 'Global Session', exact: true }).fill('copy-local-session');
    await expect(manual.getByLabel('Session', { exact: true })).toHaveValue('copy-local-session');
    await manual.getByLabel('Scope JSON', { exact: true }).fill('');
    await manual.getByLabel('Room Ref JSON', { exact: true }).fill('');
    await manual.getByLabel('Min Snapshot', { exact: true }).fill('0');
    await manual.getByLabel('Timeout', { exact: true }).fill('5000');
    await manual.getByLabel('Target Client', { exact: true }).fill('copy-local-target');
    await manual.getByRole('combobox', { name: 'Transport', exact: true }).selectOption('realtime');
    const manualCapture = manual.getByRole('combobox', { name: 'RTC capture', exact: true });
    await manual.getByLabel('Connection', { exact: true }).fill('copy-local-off');
    await manualCapture.selectOption('off');
    await manual.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(manual.locator('.manual-action-row')).toHaveCount(1);
    await expect(manual.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled();
    await manual.getByLabel('Connection', { exact: true }).fill('copy-local-native');
    await manualCapture.selectOption('native');
    await manual.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(manual.locator('.manual-action-row')).toHaveCount(2);
    await expect(manualCapture).toBeEnabled();
    await manualCapture.selectOption('signaling');
    await manual.getByRole('button', { name: 'Show Recipe', exact: true }).click();
    const expectedRecipe = {
        schemaVersion: 1,
        recipeId: 'manual-workbench-recipe',
        name: 'Manual workbench recipe',
        continueOnFailure: false,
        commands: [
            {
                kind: 'rtc.connect',
                commandId: 'manual-rtc-connect-1',
                label: 'Connect manual RTC client',
                connection: 'copy-local-off',
                actor: 'copy-local-actor',
                roomId: 'copy-local-group',
                applicationId: 'copy-local-app',
                workspaceId: 'copy-local-workspace',
                roomRef: {
                    applicationId: 'copy-local-app',
                    workspaceId: 'copy-local-workspace',
                    groupId: 'copy-local-group'
                },
                transport: 'realtime',
                timeoutMs: 5000,
                rallar: { sessionId: 'copy-local-session', rtcCaptureMode: 'off' },
                metadata: { manual: { deliveryMode: 'direct', expectedClients: ['copy-local-target'] } }
            },
            {
                kind: 'rtc.connect',
                commandId: 'manual-rtc-connect-3',
                label: 'Connect manual RTC client',
                connection: 'copy-local-native',
                actor: 'copy-local-actor',
                roomId: 'copy-local-group',
                applicationId: 'copy-local-app',
                workspaceId: 'copy-local-workspace',
                roomRef: {
                    applicationId: 'copy-local-app',
                    workspaceId: 'copy-local-workspace',
                    groupId: 'copy-local-group'
                },
                transport: 'realtime',
                timeoutMs: 5000,
                rallar: { sessionId: 'copy-local-session', rtcCaptureMode: 'native' },
                metadata: { manual: { deliveryMode: 'direct', expectedClients: ['copy-local-target'] } }
            }
        ]
    } satisfies RallarBlackBoxTestRecipe;
    expect(JSON.parse(await manual.locator('.manual-recipe-output').inputValue())).toEqual(expectedRecipe);
    await page.evaluate(() => navigator.clipboard.writeText('copy-local-sentinel-not-a-recipe'));
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('copy-local-sentinel-not-a-recipe');
    await manual.getByRole('button', { name: 'Copy Recipe', exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(JSON.stringify(expectedRecipe, null, 2));
    const copiedText = await page.evaluate(() => navigator.clipboard.readText());
    expect(validateSchemaAuthoringText('recipe', copiedText).ok).toBe(true);
    expect(JSON.parse(copiedText)).toEqual(expectedRecipe);

    await openTab(page, 'local-workbench');
    const local = page.locator('#panel-local-workbench');
    const editor = local.getByRole('textbox', { name: 'Recipe JSON', exact: true });
    await editor.fill(copiedText);
    await local.getByRole('button', { name: 'Load', exact: true }).click();
    await expect.poll(() =>
        page.evaluate(async () => {
            const modulePath = '/src/runtime-store.ts';
            const { rallarBlackBoxRuntimeStore } = await import(modulePath);
            return rallarBlackBoxRuntimeStore.getSnapshot().state.loadedRecipe;
        })
    ).toEqual(expectedRecipe);
    await expect(editor).toHaveValue(copiedText);

    const capture = local.getByRole('combobox', { name: /RTC capture/i });
    const invocations: string[] = [];
    for (const choice of ['off', '']) {
        await capture.selectOption(choice);
        await local.getByRole('button', { name: 'Run', exact: true }).click();
        await expect(local.locator('.workbench-panel .panel-heading .pill')).toHaveText('passed');
        const latest = await page.evaluate(async () => {
            const modulePath = '/src/runtime-store.ts';
            const { rallarBlackBoxRuntimeStore } = await import(modulePath);
            return rallarBlackBoxRuntimeStore.getSnapshot().state.commandHistory
                .filter((result: RallarBlackBoxTestResult) => result.kind === 'recipe.run').at(-1);
        });
        expect(latest?.ok).toBe(true);
        expect(latest?.replayed).not.toBe(true);
        const invocation = decodeRecord(decodeRecord(latest?.value).invocation);
        expect(invocation.run).toBe(choice === '' ? undefined : choice);
        const invocationId = decodeNonBlankText(invocation.invocationId);
        if (invocationId === undefined) {
            throw new Error('The copied local recipe run did not publish an invocation identity.');
        }
        expect(invocations).not.toContain(invocationId);
        invocations.push(invocationId);
        await expect(editor).toHaveValue(copiedText);
        expect(
            await page.evaluate(async () => {
                const modulePath = '/src/runtime-store.ts';
                const { rallarBlackBoxRuntimeStore } = await import(modulePath);
                return rallarBlackBoxRuntimeStore.getSnapshot().state.loadedRecipe;
            })
        ).toEqual(expectedRecipe);
    }

    await page.evaluate(() => {
        const url = new URL(window.location.href);
        url.searchParams.set('experience', 'recipe-console');
        window.history.pushState({}, '', url);
        window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.locator('.recipe-console')).toBeVisible();
    await expect(local).toHaveCount(0);
    await page.goBack();
    await expect(local).toBeVisible();
    await expect(page.locator('.recipe-console')).toHaveCount(0);
    await expect(editor).toHaveValue(copiedText);
    expect(
        await page.evaluate(async () => {
            const modulePath = '/src/runtime-store.ts';
            const { rallarBlackBoxRuntimeStore } = await import(modulePath);
            return rallarBlackBoxRuntimeStore.getSnapshot().state.loadedRecipe;
        })
    ).toEqual(expectedRecipe);
});

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
