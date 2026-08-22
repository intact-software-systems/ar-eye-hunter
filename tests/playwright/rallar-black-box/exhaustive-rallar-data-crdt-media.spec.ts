import { expect, test } from '@playwright/test';
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

test.describe('exhaustive Rallar Data, CRDT, and Media tabs', () => {
    test.skip(!config.enabled, config.skipReason);

    test('runs Rallar Data lifecycle operations and records change evidence', async ({
        page,
        request
    }, testInfo) => {
        await expectFullStackApiReady(request, config);
        const groupId = uniqueGroupId(testInfo);

        try {
            await loginUser(page, config, config.userA, {
                groupId,
                sessionId: `${groupId}-data-session`,
                tab: 'rallar-data'
            });
            const panel = page.locator('#panel-rallar-data');
            const dataControls = panel.locator('.rallar-data-context-grid');
            const value = {
                kind: 'exhaustive-rallar-data',
                groupId,
                seq: 1
            };

            await panel.getByLabel('Store').fill(`exhaustive-store-${testInfo.workerIndex}`);
            await dataControls.locator('select').nth(0).selectOption('app');
            await dataControls.locator('select').nth(1).selectOption('write-through');
            await dataControls.locator('select').nth(2).selectOption('eager');
            await dataControls.locator('input').nth(2).fill(`key-${groupId}`);
            await panel.getByLabel('Value JSON').fill(JSON.stringify(value, null, 2));

            for (
                const operation of [
                    'open',
                    'set',
                    'get',
                    'compare-and-set',
                    'flush',
                    'export',
                    'estimate-usage',
                    'clear',
                    'close',
                    'destroy'
                ]
            ) {
                if (operation === 'compare-and-set') {
                    await panel.getByLabel('Expected JSON').fill(JSON.stringify(value, null, 2));
                    await panel.getByLabel('Value JSON').fill(JSON.stringify({ ...value, seq: 2 }, null, 2));
                }
                await dataControls.locator('select').nth(3).selectOption(operation);
                await panel.getByRole('button', { name: 'Run data operation' }).click();
                await expect(panel.locator('.rallar-data-result-panel').first()).toContainText(
                    new RegExp(operation === 'close' ? 'close|{}|closed' : operation, 'i'),
                    { timeout: 30_000 }
                );
            }

            await expect(panel).toContainText(/Change Events|Result/i);
            await panel.getByRole('button', { name: 'Copy diagnostics' }).click();
            await expectNoSecrets(panel, [config.userA.password]);
        }
        finally {
            await cleanupRallarPage(page);
        }
    });

    test('covers CRDT editor document actions and non-destructive admin health surfaces', async ({
        page,
        request
    }, testInfo) => {
        await expectFullStackApiReady(request, config);
        const groupId = uniqueGroupId(testInfo);

        try {
            await loginUser(page, config, config.userA, {
                groupId,
                sessionId: `${groupId}-crdt-session`,
                tab: 'crdt-health'
            });
            const panel = page.locator('#panel-crdt-health');

            await panel.getByLabel('Document name').fill(`exhaustive-board-${testInfo.workerIndex}`);
            await panel.getByLabel('Document id').fill(`doc-${groupId}`);
            await panel.getByLabel('Transport').selectOption('local-only');
            await panel.getByRole('button', { name: 'Open', exact: true }).click();
            await expect(panel.locator('.crdt-editor-panel')).toContainText('open', {
                timeout: 30_000
            });

            await panel.getByLabel('New column').fill('QA Column');
            await panel.getByLabel('New card').fill('QA Card');
            await panel.getByRole('button', { name: 'Add Column' }).click();
            await expect(panel.locator('.crdt-editor-diagnostics')).toContainText('QA Column');
            await panel.getByRole('button', { name: 'Add Card' }).click();
            await expect(panel.locator('.crdt-editor-diagnostics')).toContainText('QA Card');
            await panel.getByRole('button', { name: 'Read' }).click();
            await panel.getByRole('button', { name: 'Close' }).click();
            await expect(panel.locator('.crdt-editor-panel')).toContainText('closed', {
                timeout: 30_000
            });

            await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
            await expect(panel).toContainText(/Admin Health|documents|No CRDT documents returned/i, {
                timeout: 30_000
            });
            const integrityRecipe = panel.getByRole('button', { name: 'Copy Integrity Recipe' });
            if (await integrityRecipe.isEnabled()) {
                await integrityRecipe.click();
            }
            const debugRecipe = panel.getByRole('button', { name: 'Copy Debug Recipe' });
            if (await debugRecipe.isEnabled()) {
                await debugRecipe.click();
            }
            await expectNoSecrets(panel, [config.userA.password]);
        }
        finally {
            await cleanupRallarPage(page);
        }
    });

    test('attaches fake media devices and exercises media controls', async ({
        page,
        request
    }, testInfo) => {
        test.setTimeout(120_000);
        await expectFullStackApiReady(request, config);
        const groupId = uniqueGroupId(testInfo);

        try {
            await loginUser(page, config, config.userA, {
                groupId,
                sessionId: `${groupId}-media-session`,
                tab: 'media'
            });
            const panel = page.locator('#panel-media');

            await panel.getByRole('button', { name: 'Attach local stream' }).click();
            await expect(panel.locator('.media-result-panel').nth(1)).toContainText(/streamId|tracks|\{\}/i, {
                timeout: 45_000
            });
            await panel.getByRole('button', { name: 'Toggle audio' }).click();
            await expect(panel).toContainText(/audio/i);
            await panel.getByRole('button', { name: 'Toggle video' }).click();
            await expect(panel).toContainText(/video/i);
            await panel.getByLabel('Media Policy JSON').fill(JSON.stringify(
                {
                    receiveAudio: true,
                    receiveVideo: false
                },
                null,
                2
            ));
            await panel.getByRole('button', { name: 'Apply media policy' }).click();
            await expect(panel).toContainText(/receiveVideo|Apply media policy|false/i);
            await panel.getByRole('button', { name: 'Subscribe remote streams' }).click();
            await expect(panel).toContainText(/Remote Streams|subscribed/i);
            await panel.getByRole('button', { name: 'Copy diagnostics' }).click();
            await panel.getByRole('button', { name: 'Stop all' }).click();
            await expect(panel).toContainText(/idle|stopped|Local stream.*-/i, { timeout: 30_000 });
            await expectNoSecrets(panel, [config.userA.password]);
        }
        finally {
            await cleanupRallarPage(page);
        }
    });
});
