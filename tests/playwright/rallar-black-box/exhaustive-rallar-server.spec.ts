import { expect, test } from '@playwright/test';
import {
    cleanupRallarPage,
    expectFullStackApiReady,
    expectNoSecrets,
    loginUser,
    readBrowserAuthSession,
    readExhaustivePostgresConfig,
    sendWsTicketFromRestWorkbench,
    uniqueGroupId
} from './full-stack-helpers.ts';

const config = readExhaustivePostgresConfig();

test.describe('exhaustive Rallar Server REST workbench', () => {
    test.skip(!config.enabled, config.skipReason);

    test('covers presets, manual requests, OpenAPI refresh, exports, redaction, and server errors', async ({
        page,
        request
    }, testInfo) => {
        await expectFullStackApiReady(request, config);
        const groupId = uniqueGroupId(testInfo);

        try {
            await loginUser(page, config, config.userA, {
                groupId,
                sessionId: `${groupId}-server-session`,
                tab: 'rallar-server'
            });
            const session = await readBrowserAuthSession(page);
            const panel = page.locator('#panel-rallar-server');
            const restControls = panel.locator('.rest-workbench-grid');

            const wsTicketHeaders = await sendWsTicketFromRestWorkbench(page, config);
            expect(wsTicketHeaders.authorization).toMatch(/^Bearer /);
            expect(wsTicketHeaders['x-client-id']).toBe(session.clientId);
            await expectNoSecrets(panel, [config.userA.password]);

            await panel.getByRole('button', { name: 'Refresh OpenAPI' }).click();
            await expect(panel).toContainText(/OpenAPI|endpoint/i, { timeout: 30_000 });

            await panel.getByLabel('Endpoint').selectOption('group-read');
            await panel.getByLabel('Path', { exact: true }).fill(
                `/api/state/apps/${encodeURIComponent(config.applicationId)}/workspaces/${
                    encodeURIComponent(config.workspaceId)
                }/groups/${encodeURIComponent(groupId)}`
            );
            await panel.getByRole('button', { name: 'Send' }).click();
            await expect(panel).toContainText(/\b(200|404)\b/, { timeout: 30_000 });

            await panel.getByRole('button', { name: 'Copy cURL' }).click();
            await panel.getByRole('button', { name: 'Copy Command' }).click();
            await expectNoSecrets(panel, [session.accessToken, config.userA.password]);

            await panel.getByLabel('Endpoint').selectOption('group-member-join');
            await panel.getByLabel('Body JSON').fill('');
            await panel.getByRole('button', { name: 'Send' }).click();
            await expect(panel).toContainText(/\b400\b|Bad Request|body/i, { timeout: 30_000 });

            await restControls.locator('select').nth(2).selectOption('text');
            await restControls.locator('select').nth(1).selectOption('GET');
            await panel.getByLabel('Path', { exact: true }).fill('/api/config');
            await panel.getByLabel('Attach auth').uncheck();
            await panel.getByRole('button', { name: 'Send' }).click();
            await expect(panel).toContainText(/\b200\b|OK/i, { timeout: 30_000 });
        }
        finally {
            await cleanupRallarPage(page);
        }
    });

    test('runs a REST collection with assertions, extraction, and copied recipe output', async ({
        page,
        request
    }, testInfo) => {
        await expectFullStackApiReady(request, config);
        const groupId = uniqueGroupId(testInfo);

        try {
            await loginUser(page, config, config.userA, {
                groupId,
                sessionId: `${groupId}-collection-session`,
                tab: 'rallar-server'
            });
            const session = await readBrowserAuthSession(page);
            const panel = page.locator('#panel-rallar-server');

            await panel.getByLabel('Variables JSON').fill(JSON.stringify(
                {
                    applicationId: config.applicationId,
                    workspaceId: config.workspaceId,
                    groupId,
                    principalId: session.clientId
                },
                null,
                2
            ));
            await panel.getByLabel('Collection JSON').fill(JSON.stringify(
                {
                    collectionId: 'exhaustive-rest-collection',
                    name: 'Exhaustive REST collection',
                    steps: [
                        {
                            stepId: 'read-config',
                            label: 'Read config',
                            request: {
                                method: 'GET',
                                path: '/api/config',
                                attachAuth: false,
                                responseBodyMode: 'json'
                            },
                            expect: { status: 200 },
                            extract: {
                                values: [
                                    { name: 'apiConfigSeen', path: '$.apiBaseUrl' }
                                ]
                            }
                        },
                        {
                            stepId: 'create-group',
                            label: 'Create group',
                            request: {
                                method: 'PUT',
                                path: '/api/state/apps/{{applicationId}}/workspaces/{{workspaceId}}/groups/{{groupId}}',
                                attachAuth: true,
                                responseBodyMode: 'json',
                                body: {
                                    displayName: '{{groupId}}',
                                    description: 'Created by exhaustive REST collection'
                                }
                            },
                            expect: { status: [200, 201, 409] }
                        }
                    ]
                },
                null,
                2
            ));

            await panel.getByRole('button', { name: 'Run Collection' }).click();
            await expect(panel).toContainText('Read config', { timeout: 45_000 });
            await expect(panel).toContainText('Create group');
            await expect(panel).toContainText(/assert|extracted|apiConfigSeen|success/i);

            await panel.getByRole('button', { name: 'Copy Collection', exact: true }).click();
            await panel.getByRole('button', { name: 'Copy Collection Recipe' }).click();
            await expectNoSecrets(panel, [session.accessToken, config.userA.password]);
        }
        finally {
            await cleanupRallarPage(page);
        }
    });
});
