import { expect, test, type JSHandle } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestResult
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { decodeNonBlankText, decodeRecord } from '@shared-test/rallar-bb-test/runtime/decode-runtime-result-values.ts';
import type { RallarRealtimeMessage } from '@shared-web/browser/rallar-realtime-facade.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import { validateSchemaAuthoringText } from '../../../apps/rallar-black-box/src/schema-authoring.ts';
import {
    cleanupRallarPage,
    expectFullStackApiReady,
    expectNoSecrets,
    loginUser,
    openTab,
    readBrowserAuthSession,
    readExhaustivePostgresConfig,
    runWithRallarReceiverPage,
    uniqueGroupId
} from './full-stack-helpers.ts';

interface CopyRepeatPayload {
    readonly topic: string;
    readonly marker: string;
    readonly value: number;
    readonly roomRef: GroupRef;
}

interface NativeReceiveRecord {
    readonly peerId: string;
    readonly laneId: string;
    readonly data: CopyRepeatPayload;
    readonly nativeMessageEvent: boolean;
    readonly nativeTarget: boolean;
    readonly targetIndex: number;
    readonly readyStateAtCallback: string;
}

interface NativeReceiveObserver {
    readonly records: NativeReceiveRecord[];
    readonly targets: RTCDataChannel[];
    unsubscribe(): void;
}

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

    test('refuses Local Full native run when actual SDK capture has no application sink', async ({
        page,
        request
    }, testInfo) => {
        await expectFullStackApiReady(request, config);
        const groupId = uniqueGroupId(testInfo);
        const connection = `${groupId}-native-refusal`;
        const connectCommandId = `${groupId}-connect`;

        try {
            const session = await loginUser({
                page,
                config,
                user: config.userA,
                groupId,
                sessionId: `${groupId}-native-refusal-session`,
                tab: 'local-workbench',
                workspace: 'black-box-runner'
            });
            const panel = page.locator('#panel-local-workbench');
            const recipe = {
                schemaVersion: 1,
                recipeId: `${groupId}-native-refusal-recipe`,
                rtcCaptureMode: 'off',
                commands: [
                    {
                        kind: 'configure',
                        commandId: `${groupId}-configure`,
                        config: { rallar: { apiBaseUrl: config.apiBaseUrl, restoreSession: true } }
                    },
                    { kind: 'rtc.connect', commandId: connectCommandId, connection }
                ]
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
            await expect(editor).toHaveValue(recipeText);
            const before = await page.evaluate(async () => {
                const modulePath = '/src/runtime-store.ts';
                const { rallarBlackBoxRuntimeStore } = await import(modulePath);
                const state = rallarBlackBoxRuntimeStore.getSnapshot().state;
                return {
                    runs: state.commandHistory.filter((result: RallarBlackBoxTestResult) =>
                        result.kind === 'recipe.run'
                    ),
                    eventIds: state.events.map((event: RallarBlackBoxTestEvent) => event.eventId)
                };
            });

            await panel.getByRole('combobox', { name: 'Run RTC capture', exact: true })
                .selectOption({ label: 'Full native' });
            const ticketResponsePromise = page.waitForResponse((response) => {
                const url = new URL(response.url());
                return response.request().method() === 'POST' &&
                    url.origin === config.apiBaseUrl &&
                    url.pathname.startsWith('/api/auth/ws-ticket/requests/');
            });
            await panel.getByRole('button', { name: 'Run', exact: true }).click();
            const ticketResponse = await ticketResponsePromise;
            expect(ticketResponse.ok()).toBe(true);
            const ticketSessionId = decodeRecord(await ticketResponse.json()).sessionId;
            expect(ticketSessionId).toBe(session.sessionId);
            await expect(panel.locator('.workbench-panel .panel-heading .pill')).toHaveText('failed');
            await expect(editor).toHaveValue(recipeText);
            const connectRow = panel.locator('.queue-row').filter({ hasText: connectCommandId });
            await expect(connectRow).toHaveCount(1);
            await expect(connectRow.locator('.pill')).toHaveText('failed');
            await connectRow.click();
            await openTab(page, 'event-stream');
            const resultJson = page.locator('#panel-event-stream .focus-panel .json-block');
            await expect.poll(async () => decodeRecord(JSON.parse(await resultJson.textContent() ?? 'null')))
                .toMatchObject({
                    commandId: connectCommandId,
                    kind: 'rtc.connect',
                    ok: false,
                    status: 'failed',
                    error: {
                        code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
                        details: {
                            reason: 'application-unavailable',
                            requestedConfiguration: { mode: 'native', origin: 'run' },
                            rtcCapture: {
                                status: 'observed',
                                value: {
                                    configuration: { mode: 'native', origin: 'run' },
                                    application: { status: 'unavailable', reason: 'sink-unavailable' },
                                    connectionId: { status: 'observed', value: expect.stringMatching(/\S/) }
                                }
                            }
                        }
                    }
                });
            const observed = await page.evaluate(async ({ connection, eventIds }) => {
                const modulePath = '/src/runtime-store.ts';
                const { rallarBlackBoxRuntimeStore } = await import(modulePath);
                const state = rallarBlackBoxRuntimeStore.getSnapshot().state;
                return {
                    loadedRecipe: state.loadedRecipe,
                    latestRun: state.commandHistory.filter((result: RallarBlackBoxTestResult) =>
                        result.kind === 'recipe.run'
                    ).at(-1),
                    topics: state.events.filter((event: RallarBlackBoxTestEvent) =>
                        event.connection === connection && !eventIds.includes(event.eventId)
                    ).map((event: RallarBlackBoxTestEvent) => event.topic)
                };
            }, { connection, eventIds: before.eventIds });
            expect(observed.loadedRecipe).toEqual(recipe);
            expect(observed.latestRun).toMatchObject({
                kind: 'recipe.run',
                ok: false,
                status: 'failed',
                value: {
                    recipeId: recipe.recipeId,
                    invocation: { invocationId: expect.stringMatching(/\S/), run: 'native', recipe: 'off' },
                    results: [
                        { kind: 'configure', ok: true },
                        { commandId: connectCommandId, kind: 'rtc.connect', ok: false, status: 'failed' }
                    ]
                }
            });
            expect(observed.latestRun?.replayed).not.toBe(true);
            const invocationId = decodeRecord(decodeRecord(observed.latestRun?.value).invocation).invocationId;
            expect(
                before.runs.map((result: RallarBlackBoxTestResult) =>
                    decodeRecord(decodeRecord(result.value).invocation).invocationId
                )
            )
                .not.toContain(invocationId);
            expect(observed.topics).toContain('rallar.browser.connect_failed');
            expect(observed.topics).not.toContain('rallar.browser.connect_completed');
        }
        finally {
            await cleanupRallarPage(page);
        }
    });

    test('Local Full native run delivers its authored payload to another browser', async ({
        page,
        browser,
        request
    }, testInfo) => {
        await expectFullStackApiReady(request, config);
        const groupId = uniqueGroupId(testInfo);
        const marker = `${groupId}-native-delivery`;
        const connection = `${groupId}-native-sender`;
        const receiverConnection = `${groupId}-receiver`;
        const connectCommandId = `${groupId}-connect`;
        const roomRef = { applicationId: config.applicationId, workspaceId: config.workspaceId, groupId };
        const expectedPayload = { topic: 'local.native.delivery', marker, roomRef, value: 37 };
        await runWithRallarReceiverPage({
            browser,
            sender: page,
            run: async (receiver) => {
                const receiverSession = await loginUser({
                    page: receiver,
                    config,
                    user: config.userB,
                    groupId,
                    sessionId: `${groupId}-receiver-session`,
                    tab: 'manual-rallar',
                    workspace: 'black-box-runner'
                });
                const manual = receiver.locator('#panel-manual-rallar');
                await manual.getByLabel('Application', { exact: true }).fill(config.applicationId);
                await manual.getByLabel('Workspace', { exact: true }).fill(config.workspaceId);
                await manual.getByLabel('Group', { exact: true }).fill(groupId);
                await manual.getByLabel('Connection', { exact: true }).fill(receiverConnection);
                await manual.getByRole('combobox', { name: 'Transport', exact: true }).selectOption('realtime');
                await manual.getByLabel('Scope JSON', { exact: true }).fill(JSON.stringify({
                    applicationId: config.applicationId,
                    workspaceId: config.workspaceId
                }));
                await manual.getByLabel('Room Ref JSON', { exact: true }).fill(JSON.stringify(roomRef));
                await expect(manual.getByLabel('Session', { exact: true })).toHaveValue(receiverSession.sessionId);
                const createPath = `/api/state/apps/${encodeURIComponent(config.applicationId)}/workspaces/${
                    encodeURIComponent(config.workspaceId)
                }/groups/requests/`;
                const createResponsePromise = receiver.waitForResponse((response) => {
                    const url = new URL(response.url());
                    return response.request().method() === 'POST' &&
                        url.origin === config.apiBaseUrl && url.pathname.startsWith(createPath);
                });
                await manual.getByRole('button', { name: 'Create and join group', exact: true }).click();
                expect([200, 201]).toContain((await createResponsePromise).status());
                await expect.poll(() =>
                    receiver.evaluate(async () => {
                        const modulePath = '/src/runtime-store.ts';
                        const { rallarBlackBoxRuntimeStore } = await import(modulePath);
                        return rallarBlackBoxRuntimeStore.getSnapshot().state.commandHistory
                            .filter((result: RallarBlackBoxTestResult) => result.kind === 'rtc.connect').at(-1);
                    })
                ).toMatchObject({
                    kind: 'rtc.connect',
                    ok: true,
                    status: 'ok',
                    value: { connection: receiverConnection }
                });

                const senderSession = await loginUser({
                    page,
                    config,
                    user: config.userA,
                    groupId,
                    sessionId: `${groupId}-sender-session`,
                    tab: 'local-workbench',
                    workspace: 'black-box-runner'
                });
                expect(senderSession.sessionId).not.toBe(receiverSession.sessionId);
                const panel = page.locator('#panel-local-workbench');
                const recipe = {
                    schemaVersion: 1,
                    recipeId: `${groupId}-local-native-delivery`,
                    rtcCaptureMode: 'off',
                    commands: [
                        {
                            kind: 'configure',
                            commandId: `${groupId}-configure`,
                            config: {
                                actor: senderSession.clientId,
                                sessionId: senderSession.sessionId,
                                roomId: groupId,
                                transport: 'realtime',
                                rallar: {
                                    apiBaseUrl: config.apiBaseUrl,
                                    applicationId: config.applicationId,
                                    workspaceId: config.workspaceId,
                                    restoreSession: true,
                                    rtcCaptureMode: 'off'
                                }
                            }
                        },
                        {
                            kind: 'rtc.connect',
                            commandId: connectCommandId,
                            connection,
                            roomId: groupId,
                            roomRef,
                            transport: 'realtime',
                            rallar: { rtcCaptureMode: 'off' },
                            readiness: { minReadyPeers: 1, timeoutMs: 5_000, intervalMs: 100 }
                        },
                        {
                            kind: 'rtc.send',
                            commandId: `${groupId}-send`,
                            connection,
                            roomRef,
                            transport: 'realtime',
                            send: { peerIds: [receiverSession.sessionId], laneId: 'realtime', data: expectedPayload }
                        }
                    ]
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
                await expect(editor).toHaveValue(recipeText);
                const before = await page.evaluate(async () => {
                    const modulePath = '/src/runtime-store.ts';
                    const { rallarBlackBoxRuntimeStore } = await import(modulePath);
                    const state = rallarBlackBoxRuntimeStore.getSnapshot().state;
                    return {
                        runs: state.commandHistory.filter((result: RallarBlackBoxTestResult) =>
                            result.kind === 'recipe.run'
                        ),
                        loaded: state.events.filter((event: RallarBlackBoxTestEvent) =>
                            event.topic === 'rallar.bb.recipe.loaded'
                        ).at(-1),
                        eventIds: state.events.map((event: RallarBlackBoxTestEvent) => event.eventId)
                    };
                });
                const recipeBodyId = decodeNonBlankText(decodeRecord(before.loaded?.payload).recipeBodyId);
                expect(recipeBodyId).toEqual(expect.stringMatching(/\S/));
                const receiverBefore = await receiver.evaluate(async () => {
                    const modulePath = '/src/runtime-store.ts';
                    const { rallarBlackBoxRuntimeStore } = await import(modulePath);
                    return rallarBlackBoxRuntimeStore.getSnapshot().state.events;
                });
                expect(
                    receiverBefore.filter((event: RallarBlackBoxTestEvent) =>
                        decodeRecord(decodeRecord(event.payload).data).marker === marker
                    )
                ).toEqual([]);
                const receiverEventIds = receiverBefore.map((event: RallarBlackBoxTestEvent) => event.eventId);
                const receivedRow = manual.locator('.received-row').filter({ hasText: marker });
                await expect(receivedRow).toHaveCount(0);
                await testInfo.attach('local-native-delivery-preimage', {
                    body: Buffer.from(JSON.stringify(
                        {
                            before,
                            receiverBefore,
                            senderSessionId: senderSession.sessionId,
                            receiverSessionId: receiverSession.sessionId,
                            recipeBodyId
                        },
                        null,
                        2
                    )),
                    contentType: 'application/json'
                });

                await panel.getByRole('combobox', { name: 'Run RTC capture', exact: true })
                    .selectOption({ label: 'Full native' });
                await panel.getByRole('button', { name: 'Run', exact: true }).click();
                await expect(panel.locator('.workbench-panel .panel-heading .pill')).toHaveText('passed');
                await expect(editor).toHaveValue(recipeText);
                const observed = await page.evaluate(async () => {
                    const modulePath = '/src/runtime-store.ts';
                    const { rallarBlackBoxRuntimeStore } = await import(modulePath);
                    const state = rallarBlackBoxRuntimeStore.getSnapshot().state;
                    return {
                        loadedRecipe: state.loadedRecipe,
                        latestRun: state.commandHistory.filter((result: RallarBlackBoxTestResult) =>
                            result.kind === 'recipe.run'
                        ).at(-1)
                    };
                });
                expect(observed.loadedRecipe).toEqual(recipe);
                expect(observed.latestRun).toMatchObject({
                    kind: 'recipe.run',
                    ok: true,
                    status: 'ok',
                    value: {
                        recipeId: recipe.recipeId,
                        invocation: {
                            invocationId: expect.stringMatching(/\S/),
                            recipeBodyId,
                            run: 'native',
                            recipe: 'off'
                        },
                        results: [
                            { commandId: `${groupId}-configure`, kind: 'configure', ok: true, status: 'ok' },
                            { commandId: connectCommandId, kind: 'rtc.connect', ok: true, status: 'ok' },
                            { commandId: `${groupId}-send`, kind: 'rtc.send', ok: true, status: 'ok' }
                        ]
                    }
                });
                expect(observed.latestRun?.replayed).not.toBe(true);
                const invocationId = decodeRecord(decodeRecord(observed.latestRun?.value).invocation).invocationId;
                expect(
                    before.runs.map((result: RallarBlackBoxTestResult) =>
                        decodeRecord(decodeRecord(result.value).invocation).invocationId
                    )
                ).not.toContain(invocationId);
                const connectRow = panel.locator('.queue-row').filter({ hasText: connectCommandId });
                await expect(connectRow).toHaveCount(1);
                await connectRow.click();
                await openTab(page, 'event-stream');
                const resultJson = page.locator('#panel-event-stream .focus-panel .json-block');
                await expect.poll(async () => decodeRecord(JSON.parse(await resultJson.textContent() ?? 'null')))
                    .toMatchObject({
                        commandId: connectCommandId,
                        kind: 'rtc.connect',
                        ok: true,
                        status: 'ok',
                        value: {
                            connection,
                            rtcCapture: {
                                status: 'observed',
                                value: {
                                    configuration: { mode: 'native', origin: 'run' },
                                    configurationVersion: 1,
                                    application: { status: 'applied', mode: 'native' },
                                    connectionId: { status: 'observed', value: expect.stringMatching(/\S/) },
                                    nativeScopeId: { status: 'observed', value: expect.stringMatching(/\S/) },
                                    nativeAvailability: { status: 'observed', value: 'enabled' },
                                    nativeCoverage: expect.stringMatching(/^(attached|partial)$/)
                                }
                            },
                            readiness: {
                                ready: true,
                                readyPeerIds: expect.arrayContaining([receiverSession.sessionId])
                            }
                        }
                    });
                const connectValue = decodeRecord(
                    decodeRecord(JSON.parse(await resultJson.textContent() ?? 'null')).value
                );
                const receipt = decodeRecord(decodeRecord(connectValue.rtcCapture).value);
                const nativeScopeId = decodeRecord(receipt.nativeScopeId).value;
                await expect.poll(() =>
                    page.evaluate(async (eventIds) => {
                        const modulePath = '/src/runtime-store.ts';
                        const { rallarBlackBoxRuntimeStore } = await import(modulePath);
                        return rallarBlackBoxRuntimeStore.getSnapshot().state.events.filter((
                            event: RallarBlackBoxTestEvent
                        ) => event.topic === 'rallar.browser.rtc.signaling_diagnostics' &&
                            !eventIds.includes(event.eventId)
                        );
                    }, before.eventIds)
                ).toEqual(expect.arrayContaining([expect.objectContaining({
                    kind: 'diagnostic',
                    payload: expect.objectContaining({
                        data: expect.objectContaining({
                            kind: 'native-state',
                            trigger: 'channel-open',
                            localSessionId: senderSession.sessionId,
                            peerSessionId: receiverSession.sessionId,
                            native: expect.objectContaining({
                                capture: expect.objectContaining({
                                    scope: 'active',
                                    scopeId: { status: 'observed', value: nativeScopeId }
                                }),
                                identity: {
                                    peerConnectionId: { status: 'observed', value: expect.stringMatching(/\S/) },
                                    channelId: { status: 'observed', value: expect.stringMatching(/\S/) }
                                },
                                state: expect.objectContaining({ channelState: { status: 'observed', value: 'open' } })
                            })
                        })
                    })
                })]));
                await expect.poll(() =>
                    receiver.evaluate(async (eventIds) => {
                        const modulePath = '/src/runtime-store.ts';
                        const { rallarBlackBoxRuntimeStore } = await import(modulePath);
                        return rallarBlackBoxRuntimeStore.getSnapshot().state.events.filter((
                            event: RallarBlackBoxTestEvent
                        ) => event.kind === 'message' && !eventIds.includes(event.eventId));
                    }, receiverEventIds)
                ).toEqual(expect.arrayContaining([expect.objectContaining({
                    kind: 'message',
                    topic: 'rallar.browser.realtime.message',
                    transport: 'realtime',
                    connection: receiverConnection,
                    payload: expect.objectContaining({
                        laneId: 'realtime',
                        remotePeerId: senderSession.sessionId,
                        data: expectedPayload
                    })
                })]));
                await expect(receivedRow.first()).toBeVisible();
                expect(JSON.parse(await receivedRow.first().locator('.mini-json').textContent() ?? 'null'))
                    .toEqual(expectedPayload);
            },
            captureEvidence: async (receiverPage) => {
                const senderEvidence = await page.evaluate(async () => {
                    const modulePath = '/src/runtime-store.ts';
                    const { rallarBlackBoxRuntimeStore } = await import(modulePath);
                    const state = rallarBlackBoxRuntimeStore.getSnapshot().state;
                    return {
                        loadedRecipe: state.loadedRecipe,
                        commandHistory: state.commandHistory,
                        events: state.events
                    };
                }).catch(() => undefined);
                const receiverEvidence = receiverPage === undefined
                    ? undefined
                    : await receiverPage.evaluate(async () => {
                        const modulePath = '/src/runtime-store.ts';
                        const { rallarBlackBoxRuntimeStore } = await import(modulePath);
                        const state = rallarBlackBoxRuntimeStore.getSnapshot().state;
                        return { commandHistory: state.commandHistory, events: state.events };
                    }).catch(() => undefined);
                await testInfo.attach('local-native-delivery-observations', {
                    body: Buffer.from(
                        JSON.stringify({ groupId, expectedPayload, senderEvidence, receiverEvidence }, null, 2)
                    ),
                    contentType: 'application/json'
                });
            }
        });
    });

    test('copies complete Manual history and repeats Local native delivery on new receive channels', async ({
        page,
        context,
        browser,
        request
    }, testInfo) => {
        await expectFullStackApiReady(request, config);
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        const groupId = uniqueGroupId(testInfo);
        const roomRef = { applicationId: config.applicationId, workspaceId: config.workspaceId, groupId };
        const scope = { applicationId: config.applicationId, workspaceId: config.workspaceId };
        const expectedPayload = { topic: 'local.copy.repeat', marker: 'actual-copy-repeat', value: 61, roomRef };
        const connection = `${groupId}-copy-sender`;
        const moduleUrl = `/@fs${path.join(REPO_ROOT, 'packages/shared-web/browser/rallar.ts')}`;
        let retainedObserver: JSHandle<NativeReceiveObserver> | undefined;
        await runWithRallarReceiverPage({
            browser,
            sender: page,
            run: async (receiver) => {
                const receiverSession = await loginUser({
                    page: receiver,
                    config,
                    user: config.userB,
                    groupId,
                    sessionId: `${groupId}-receiver-session`,
                    tab: 'manual-rallar',
                    workspace: 'black-box-runner'
                });
                const created = await receiver.evaluate(async ({ moduleUrl, apiBaseUrl, roomRef }) => {
                    const { rallar } = await import(moduleUrl);
                    rallar.configure({ apiBaseUrl });
                    rallar.setDefaults({ applicationId: roomRef.applicationId, workspaceId: roomRef.workspaceId });
                    await rallar.connect({ timeoutMs: 5_000 });
                    const snapshot = await rallar.rooms.create({
                        groupId: roomRef.groupId,
                        displayName: roomRef.groupId,
                        joinMode: 'open',
                        timeoutMs: 5_000
                    });
                    return {
                        roomRef: rallar.rooms.state().currentRoomRef,
                        sessionId: rallar.session()?.sessionId,
                        activeSessionIds: snapshot.activeSessions.map((entry: { sessionId: string; }) =>
                            entry.sessionId
                        )
                    };
                }, { moduleUrl, apiBaseUrl: config.apiBaseUrl, roomRef });
                expect(created).toMatchObject({
                    roomRef,
                    sessionId: receiverSession.sessionId,
                    activeSessionIds: [receiverSession.sessionId]
                });

                const observer = await receiver.evaluateHandle(async (moduleUrl) => {
                    const { rallar } = await import(moduleUrl);
                    const records: NativeReceiveRecord[] = [];
                    const targets: RTCDataChannel[] = [];
                    const unsubscribe = rallar.realtime.onJson(
                        'realtime',
                        (message: RallarRealtimeMessage<CopyRepeatPayload>) => {
                            const target = message.event.target;
                            const nativeTarget = target instanceof RTCDataChannel;
                            if (nativeTarget && !targets.includes(target)) {
                                targets.push(target);
                            }
                            records.push({
                                peerId: message.peerId,
                                laneId: message.laneId,
                                data: message.data,
                                nativeMessageEvent: message.event instanceof MessageEvent,
                                nativeTarget,
                                targetIndex: nativeTarget ? targets.indexOf(target) : -1,
                                readyStateAtCallback: nativeTarget ? target.readyState : 'unavailable'
                            });
                        }
                    );
                    return { records, targets, unsubscribe };
                }, moduleUrl);

                retainedObserver = observer;
                const senderSession = await loginUser({
                    page,
                    config,
                    user: config.userA,
                    groupId,
                    sessionId: `${groupId}-sender-session`,
                    tab: 'manual-rallar',
                    workspace: 'black-box-runner',
                    rallarLeaveRoomOnClose: false
                });
                expect(senderSession.sessionId).not.toBe(receiverSession.sessionId);
                const manual = page.locator('#panel-manual-rallar');
                for (
                    const [label, value] of [
                        ['Environment', 'actual-copy-repeat'],
                        ['API Base URL', config.apiBaseUrl],
                        ['Application', config.applicationId],
                        ['Workspace', config.workspaceId],
                        ['Group', groupId],
                        ['Actor', senderSession.clientId],
                        ['Session', senderSession.sessionId],
                        ['Connection', connection],
                        ['Target Client', receiverSession.sessionId],
                        ['Scope JSON', JSON.stringify(scope)],
                        ['Room Ref JSON', JSON.stringify(roomRef)],
                        ['Min Snapshot', '0'],
                        ['Timeout', '5000'],
                        ['Topic', 'local.copy.repeat']
                    ]
                ) {
                    await manual.getByLabel(label, { exact: true }).fill(value);
                }
                await manual.getByRole('combobox', { name: 'Transport', exact: true }).selectOption('realtime');
                await manual.getByRole('textbox', { name: 'RTC readiness JSON', exact: true })
                    .fill('{"minReadyPeers":1,"timeoutMs":5000,"intervalMs":100}');
                await manual.getByRole('group', { name: 'Delivery mode', exact: true })
                    .getByRole('button', { name: 'direct', exact: true }).click();
                await manual.getByRole('combobox', { name: 'RTC capture', exact: true }).selectOption('off');
                await manual.getByRole('textbox', { name: 'Payload JSON', exact: true }).fill(
                    JSON.stringify(expectedPayload)
                );
                for (
                    const [action, kind, commandId] of [
                        ['Configure group', 'configure', 'manual-configure-1'],
                        ['Connect', 'rtc.connect', 'manual-rtc-connect-3'],
                        ['Send payload', 'rtc.send', 'manual-rtc-send-direct-5']
                    ]
                ) {
                    await manual.getByRole('button', { name: action, exact: true }).click();
                    await expect(manual.getByRole('button', { name: action, exact: true })).toBeEnabled();
                    await expect.poll(() =>
                        page.evaluate(async () => {
                            const modulePath = '/src/runtime-store.ts';
                            const { rallarBlackBoxRuntimeStore } = await import(modulePath);
                            return rallarBlackBoxRuntimeStore.getSnapshot().state.commandHistory.at(-1);
                        })
                    ).toMatchObject({
                        commandId,
                        kind,
                        ok: true,
                        status: 'ok',
                        ...(kind === 'configure'
                            ? { value: { config: { rallar: { leaveRoomOnClose: false } } } }
                            : {})
                    });
                }
                await expect.poll(() => observer.evaluate(({ records }) => records), {
                    timeout: 5_000,
                    intervals: [100]
                }).toEqual(expect.arrayContaining([expect.objectContaining({
                    peerId: senderSession.sessionId,
                    laneId: 'realtime',
                    data: expectedPayload,
                    nativeMessageEvent: true,
                    nativeTarget: true,
                    readyStateAtCallback: 'open'
                })]));

                const scopedFields = { ...scope, scope, roomRef };
                const expectedRecipe = {
                    schemaVersion: 1,
                    recipeId: 'manual-workbench-recipe',
                    name: 'Manual workbench recipe',
                    continueOnFailure: false,
                    commands: [
                        {
                            kind: 'configure',
                            commandId: 'manual-configure-1',
                            label: 'Configure manual group',
                            config: {
                                runId: 'manual-workbench-1',
                                agentId: 'visible-agent-local',
                                environment: 'actual-copy-repeat',
                                apiBaseUrl: config.apiBaseUrl,
                                actor: senderSession.clientId,
                                sessionId: senderSession.sessionId,
                                roomId: groupId,
                                transport: 'realtime',
                                control: {
                                    mode: 'manual-workbench',
                                    providerMode: 'browser-rallar',
                                    protocolVersion: 1,
                                    connected: false
                                },
                                defaults: {
                                    timeoutMs: 5_000,
                                    connection,
                                    providerMode: 'browser-rallar',
                                    ...scopedFields
                                },
                                rallar: {
                                    username: config.userA.username,
                                    restoreSession: true,
                                    leaveRoomOnClose: false,
                                    rtcCaptureMode: 'off',
                                    ...scopedFields
                                }
                            }
                        },
                        {
                            kind: 'rtc.connect',
                            readiness: { minReadyPeers: 1, timeoutMs: 5_000, intervalMs: 100 },
                            commandId: 'manual-rtc-connect-3',
                            label: 'Connect manual RTC client',
                            connection,
                            actor: senderSession.clientId,
                            roomId: groupId,
                            ...scopedFields,
                            transport: 'realtime',
                            timeoutMs: 5_000,
                            rallar: { sessionId: senderSession.sessionId, rtcCaptureMode: 'off' },
                            metadata: {
                                manual: { deliveryMode: 'direct', expectedClients: [receiverSession.sessionId] }
                            }
                        },
                        {
                            kind: 'rtc.send',
                            commandId: 'manual-rtc-send-direct-5',
                            label: 'RTC direct',
                            connection,
                            transport: 'realtime',
                            ...scopedFields,
                            send: { data: expectedPayload, roomId: groupId, peerIds: [receiverSession.sessionId] },
                            timeoutMs: 5_000,
                            metadata: {
                                manual: {
                                    groupId,
                                    topic: 'local.copy.repeat',
                                    deliveryMode: 'direct',
                                    targets: [receiverSession.sessionId],
                                    ...scopedFields
                                }
                            }
                        }
                    ]
                } satisfies RallarBlackBoxTestRecipe;
                await manual.getByRole('button', { name: 'Copy Recipe', exact: true }).click();
                await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
                    .toBe(JSON.stringify(expectedRecipe, null, 2));
                const copiedText = await page.evaluate(() => navigator.clipboard.readText());
                expect(JSON.parse(copiedText)).toEqual(expectedRecipe);
                await openTab(page, 'local-workbench');
                const local = page.locator('#panel-local-workbench');
                const editor = local.getByRole('textbox', { name: 'Recipe JSON', exact: true });
                await editor.fill(copiedText);
                await local.getByRole('button', { name: 'Load', exact: true }).click();
                await expect(editor).toHaveValue(copiedText);
                const invocations: string[] = [];
                const phases = [];
                for (const phase of [1, 2]) {
                    const before = await observer.evaluate(({ records, targets }) => ({
                        records,
                        targetStates: targets.map((target) => target.readyState)
                    }));
                    const matchingBefore = before.records.filter((record) => record.data.topic === 'local.copy.repeat');
                    expect(matchingBefore.length).toBeGreaterThanOrEqual(phase);
                    for (const record of matchingBefore) {
                        expect(record).toMatchObject({
                            data: expectedPayload,
                            peerId: senderSession.sessionId,
                            laneId: 'realtime',
                            nativeMessageEvent: true,
                            nativeTarget: true,
                            readyStateAtCallback: 'open'
                        });
                        expect(record.targetIndex).toBeGreaterThanOrEqual(0);
                    }
                    const precedingSends = await page.evaluate(async () => {
                        const modulePath = '/src/runtime-store.ts';
                        const { rallarBlackBoxRuntimeStore } = await import(modulePath);
                        return rallarBlackBoxRuntimeStore.getSnapshot().state.commandHistory
                            .filter((result: RallarBlackBoxTestResult) => result.kind === 'rtc.send');
                    });
                    expect(precedingSends).toHaveLength(phase);
                    for (const send of precedingSends) {
                        expect(send).toMatchObject({
                            commandId: 'manual-rtc-send-direct-5',
                            kind: 'rtc.send',
                            ok: true
                        });
                    }
                    await openTab(page, 'manual-rallar');
                    await manual.getByRole('button', { name: 'Close connections', exact: true }).click();
                    await expect.poll(() =>
                        page.evaluate(async () => {
                            const modulePath = '/src/runtime-store.ts';
                            const { rallarBlackBoxRuntimeStore } = await import(modulePath);
                            return rallarBlackBoxRuntimeStore.getSnapshot().state.commandHistory
                                .filter((result: RallarBlackBoxTestResult) => result.kind === 'close').at(-1);
                        })
                    ).toMatchObject({
                        commandId: phase === 1 ? 'manual-close-7' : 'manual-close-9',
                        kind: 'close',
                        ok: true,
                        status: 'ok',
                        value: {
                            closed: true,
                            rallar: { leftRoom: false, logout: false, disconnected: true, cleanupErrors: [] }
                        }
                    });
                    await expect.poll(
                        () =>
                            observer.evaluate(({ targets }) =>
                                targets.length > 0 && targets.every((target) => target.readyState === 'closed')
                            ),
                        { timeout: 5_000, intervals: [100] }
                    ).toBe(true);
                    const retired = await observer.evaluate(({ records, targets }) => ({
                        recordCount: records.length,
                        targetCount: targets.length,
                        targetStates: targets.map((target) => target.readyState)
                    }));
                    expect((await readBrowserAuthSession(page)).sessionId).toBe(senderSession.sessionId);
                    expect((await readBrowserAuthSession(receiver)).sessionId).toBe(receiverSession.sessionId);
                    await openTab(page, 'local-workbench');
                    await local.getByRole('combobox', { name: 'Run RTC capture', exact: true })
                        .selectOption({ label: 'Full native' });
                    await expect(editor).toHaveValue(copiedText);
                    await local.getByRole('button', { name: 'Run', exact: true }).click();
                    await expect(local.locator('.workbench-panel .panel-heading .pill')).toHaveText('passed');
                    await expect.poll(() =>
                        observer.evaluate(({ records, targets }, retired) => ({
                            records: records.slice(retired.recordCount).filter((record) =>
                                record.targetIndex >= retired.targetCount
                            ),
                            precedingTargetsClosed: targets.slice(0, retired.targetCount)
                                .every((target) => target.readyState === 'closed')
                        }), retired), { timeout: 5_000, intervals: [100] }).toMatchObject({
                            precedingTargetsClosed: true,
                            records: expect.arrayContaining([
                                expect.objectContaining({
                                    data: expectedPayload,
                                    peerId: senderSession.sessionId,
                                    laneId: 'realtime',
                                    nativeMessageEvent: true,
                                    nativeTarget: true,
                                    readyStateAtCallback: 'open'
                                })
                            ])
                        });
                    const observed = await page.evaluate(async () => {
                        const modulePath = '/src/runtime-store.ts';
                        const { rallarBlackBoxRuntimeStore } = await import(modulePath);
                        const state = rallarBlackBoxRuntimeStore.getSnapshot().state;
                        return {
                            loadedRecipe: state.loadedRecipe,
                            latestRun: state.commandHistory.filter((result: RallarBlackBoxTestResult) =>
                                result.kind === 'recipe.run'
                            ).at(-1)
                        };
                    });
                    expect(observed.loadedRecipe).toEqual(expectedRecipe);
                    expect(observed.latestRun).toMatchObject({
                        kind: 'recipe.run',
                        ok: true,
                        status: 'ok',
                        value: {
                            recipeId: 'manual-workbench-recipe',
                            invocation: {
                                invocationId: expect.stringMatching(/\S/),
                                recipeBodyId: expect.stringMatching(/\S/),
                                run: 'native'
                            },
                            results: [
                                { commandId: 'manual-configure-1', kind: 'configure', ok: true },
                                {
                                    commandId: 'manual-rtc-connect-3',
                                    kind: 'rtc.connect',
                                    ok: true,
                                    value: {
                                        sessionId: senderSession.sessionId,
                                        rtcCapture: {
                                            status: 'observed',
                                            value: {
                                                configuration: { mode: 'native', origin: 'run' },
                                                application: { status: 'applied', mode: 'native' }
                                            }
                                        }
                                    }
                                },
                                { commandId: 'manual-rtc-send-direct-5', kind: 'rtc.send', ok: true }
                            ]
                        }
                    });
                    expect(observed.latestRun?.replayed).not.toBe(true);
                    const invocationId = decodeNonBlankText(
                        decodeRecord(decodeRecord(observed.latestRun?.value).invocation).invocationId
                    );
                    if (!invocationId) {
                        throw new Error('Copied Local run did not publish an invocation identity.');
                    }
                    expect(invocations).not.toContain(invocationId);
                    invocations.push(invocationId);
                    expect((await readBrowserAuthSession(page)).sessionId).toBe(senderSession.sessionId);
                    expect((await readBrowserAuthSession(receiver)).sessionId).toBe(receiverSession.sessionId);
                    await expect(editor).toHaveValue(copiedText);
                    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(copiedText);
                    phases.push({ phase, before, precedingSends, retired, observed });
                }
                const evidencePath = testInfo.outputPath('actual-copy-repeat-observations.json');
                await writeFile(
                    evidencePath,
                    JSON.stringify(
                        {
                            groupId,
                            roomRef,
                            expectedPayload,
                            copiedText,
                            senderSessionId: senderSession.sessionId,
                            receiverSessionId: receiverSession.sessionId,
                            phases,
                            received: await observer.evaluate(({ records, targets }) => ({
                                records,
                                targetStates: targets.map((target) => target.readyState)
                            }))
                        },
                        null,
                        2
                    )
                );
                await testInfo.attach('actual-copy-repeat-observations', {
                    path: evidencePath,
                    contentType: 'application/json'
                });
            },
            captureEvidence: async (receiver) => {
                const observer = retainedObserver;
                const failures: PromiseRejectedResult[] = [];
                const finalizationSteps = [
                    async () => {
                        const senderState = await page.evaluate(async () => {
                            const modulePath = '/src/runtime-store.ts';
                            const { rallarBlackBoxRuntimeStore } = await import(modulePath);
                            const state = rallarBlackBoxRuntimeStore.getSnapshot().state;
                            return {
                                loadedRecipe: state.loadedRecipe,
                                commandHistory: state.commandHistory,
                                events: state.events
                            };
                        });
                        const received = observer === undefined ? undefined : await observer.evaluate(
                            ({ records, targets }) => ({
                                records,
                                targetStates: targets.map((target) => target.readyState)
                            })
                        );
                        const evidencePath = testInfo.outputPath('actual-copy-repeat-final-state.json');
                        await writeFile(
                            evidencePath,
                            JSON.stringify({ groupId, expectedPayload, senderState, received }, null, 2)
                        );
                        await testInfo.attach('actual-copy-repeat-final-state', {
                            path: evidencePath,
                            contentType: 'application/json'
                        });
                    },
                    () => observer?.evaluate(({ unsubscribe }) => unsubscribe()),
                    () => observer?.dispose(),
                    async () => {
                        if (receiver !== undefined) {
                            await receiver.evaluate(async (moduleUrl) => {
                                const { rallar } = await import(moduleUrl);
                                await rallar.disconnect();
                            }, moduleUrl);
                        }
                    }
                ];
                for (const finalize of finalizationSteps) {
                    const [result] = await Promise.allSettled([Promise.resolve().then(finalize)]);
                    if (result.status === 'rejected') {
                        failures.push(result);
                    }
                }
                if (failures.length === 1) {
                    throw failures[0].reason;
                }
                if (failures.length > 1) {
                    throw new AggregateError(
                        failures.map((failure) => failure.reason),
                        'Copy observer finalization failed.',
                        {
                            cause: failures[0].reason
                        }
                    );
                }
            }
        });
    });

    test('runs Manual Rallar actions, history, matrix exports, and cleanup', async ({
        page,
        request
    }, testInfo) => {
        test.setTimeout(150_000);
        await expectFullStackApiReady(request, config);
        const groupId = uniqueGroupId(testInfo);

        try {
            await loginUser({
                page,
                config,
                user: config.userA,
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
            await loginUser({
                page,
                config,
                user: config.userA,
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
            const readiness = panel.getByRole('textbox', { name: 'RTC readiness JSON', exact: true });
            await expect(readiness).toHaveValue('');

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

            const retainedRecipeText = await panel.locator('.manual-recipe-output').inputValue();
            const retainedCommands = decodeRecord(retainedExport.parsed).commands;
            if (!Array.isArray(retainedCommands)) {
                throw new Error('Manual history export did not contain its command array.');
            }
            for (const command of retainedCommands) {
                const authored = decodeRecord(command);
                if (authored.kind === 'rtc.connect') {
                    expect(authored.readiness).toBeUndefined();
                }
            }
            const readinessText = '{"minReadyPeers":1,"timeoutMs":5000,"intervalMs":100}';
            await readiness.fill(readinessText);
            await expect(readiness).toHaveAttribute('aria-invalid', 'false');
            await expect(panel.locator('.manual-recipe-output')).toHaveValue(retainedRecipeText);
            await expect(panel.locator('.manual-action-row')).toHaveCount(3);
            await page.reload();
            await expect(capture).toHaveValue('signaling');
            await expect(readiness).toHaveValue(readinessText);
            await readiness.fill('{"minReadyPeers":');
            await expect(readiness).toHaveAttribute('aria-invalid', 'true');
            for (
                const name of [
                    'Connect',
                    'Create and join group',
                    'Run Realtime Matrix',
                    'Run Messages Matrix',
                    'Copy Matrix Recipe',
                    'Copy Negative Recipe'
                ]
            ) {
                await expect(panel.getByRole('button', { name, exact: true })).toBeDisabled();
            }
            await expect(panel.getByRole('button', { name: 'Send payload', exact: true })).toBeEnabled();
            await expect(panel.getByRole('button', { name: 'NACK Probe', exact: true })).toBeEnabled();
            await page.reload();
            await expect(readiness).toHaveValue('{"minReadyPeers":');
            await expect(readiness).toHaveAttribute('aria-invalid', 'true');
            await expect(panel.getByRole('button', { name: 'Connect', exact: true })).toBeDisabled();
            await panel.getByRole('button', { name: 'Reset runtime', exact: true }).click();
            await expect(readiness).toHaveValue('');
            await expect(readiness).toHaveAttribute('aria-invalid', 'false');
            await expect(panel.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled();
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

    test('builds and runs Flow Builder recipes and copies exports', async ({
        page,
        request
    }, testInfo) => {
        await expectFullStackApiReady(request, config);
        const groupId = uniqueGroupId(testInfo);

        try {
            await loginUser({
                page,
                config,
                user: config.userA,
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
            await loginUser({
                page,
                config,
                user: config.userA,
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
