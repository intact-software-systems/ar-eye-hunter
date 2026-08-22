import { expect, test, type APIRequestContext, type Locator } from '@playwright/test';
import {
    expectFullStackApiReady,
    loginThroughUi,
    readBrowserAuthSession,
    readFullStackConfig,
    sendWsTicketFromRestWorkbench,
    uniqueSuffix,
    type BrowserAuthSession
} from './full-stack-helpers.ts';

const config = readFullStackConfig();
const statusMatcher = /^(\d{3}) /;

test.describe('full-stack Rallar Server REST workbench', () => {
    test.skip(!config.enabled, config.skipReason);

    test('two isolated browsers log in and send authenticated REST requests', async ({ browser, request }) => {
        test.setTimeout(120_000);
        await expectFullStackApiReady(request, config);

        const suffix = uniqueSuffix();
        const contextA = await browser.newContext();
        const contextB = await browser.newContext();
        const pageA = await contextA.newPage();
        const pageB = await contextB.newPage();

        try {
            await loginThroughUi(pageA, config, config.userA, {
                suffix: `a-${suffix}`,
                tab: 'rallar-server'
            });
            await loginThroughUi(pageB, config, config.userB, {
                suffix: `b-${suffix}`,
                tab: 'rallar-server'
            });
            const authSessionA = await readBrowserAuthSession(pageA);
            const authSessionB = await readBrowserAuthSession(pageB);

            const [headersA, headersB] = await Promise.all([
                sendWsTicketFromRestWorkbench(pageA, config),
                sendWsTicketFromRestWorkbench(pageB, config)
            ]);

            expect(headersA.authorization).toMatch(/^Bearer /);
            expect(headersA['x-client-id']).toBe(authSessionA.clientId);
            expect(headersB.authorization).toMatch(/^Bearer /);
            expect(headersB['x-client-id']).toBe(authSessionB.clientId);
            expect(headersA.authorization).not.toBe(headersB.authorization);

            await expect(pageA.locator('#panel-rallar-server')).toContainText('<redacted>');
        }
        finally {
            await Promise.all([
                contextA.close(),
                contextB.close()
            ]);
        }
    });

    test('logs in and joins an existing group with the authenticated client id', async ({ page, request }) => {
        test.setTimeout(120_000);
        await expectFullStackApiReady(request, config);

        const suffix = uniqueSuffix();
        await loginThroughUi(page, config, config.userA, {
            suffix: `group-join-${suffix}`,
            tab: 'rallar-server'
        });
        const authSession = await readBrowserAuthSession(page);
        const panel = page.locator('#panel-rallar-server');
        const scopePath = stateScopePath();

        await ensureGroupExists(panel, request, authSession, scopePath);

        const joinRequestPromise = page.waitForRequest((request) => {
            const url = new URL(request.url());
            return request.method() === 'PUT' &&
                url.origin === config.apiBaseUrl &&
                url.pathname.includes(`${scopePath}/groups/${encodeURIComponent(config.roomId)}/members/`);
        });
        const joinResponsePromise = page.waitForResponse((response) => {
            const request = response.request();
            const url = new URL(response.url());
            return request.method() === 'PUT' &&
                url.origin === config.apiBaseUrl &&
                url.pathname.includes(`${scopePath}/groups/${encodeURIComponent(config.roomId)}/members/`);
        });

        await panel.getByLabel('Endpoint').selectOption('group-member-join');
        await panel.getByRole('button', { name: 'Send' }).click();

        const [joinRequest, joinResponse] = await Promise.all([
            joinRequestPromise,
            joinResponsePromise
        ]);
        const joinPath = new URL(joinRequest.url()).pathname;
        const joinMutationPath = `${scopePath}/groups/${encodeURIComponent(config.roomId)}/members/${
            encodeURIComponent(authSession.clientId)
        }`;

        expect(isStrictMutationPath(joinPath, joinMutationPath)).toBe(true);
        expect(joinRequest.headers().authorization).toMatch(/^Bearer /);
        expect(joinRequest.headers()['x-client-id']).toBe(authSession.clientId);
        const joinBody = JSON.parse(joinRequest.postData() ?? '{}');
        expect(joinBody).toMatchObject({
            status: 'active'
        });
        expect(joinBody).not.toHaveProperty('requestId');
        expect([200, 201]).toContain(joinResponse.status());
        await expectResponseStatus(panel, [200, 201]);
    });

    test('surfaces live group-join request errors from Rallar Server', async ({ page, request }) => {
        test.setTimeout(120_000);
        await expectFullStackApiReady(request, config);

        const suffix = uniqueSuffix();
        await loginThroughUi(page, config, config.userA, {
            suffix: `group-join-negative-${suffix}`,
            tab: 'rallar-server'
        });
        const authSession = await readBrowserAuthSession(page);
        const panel = page.locator('#panel-rallar-server');
        const scopePath = stateScopePath();

        await ensureGroupExists(panel, request, authSession, scopePath);

        await panel.getByLabel('Endpoint').selectOption('group-member-join');
        await panel.getByLabel('Body JSON').fill('');

        const emptyBodyResponsePromise = page.waitForResponse((response) => {
            const request = response.request();
            const url = new URL(response.url());
            return request.method() === 'PUT' &&
                url.origin === config.apiBaseUrl &&
                isStrictMutationPath(
                    url.pathname,
                    `${scopePath}/groups/${encodeURIComponent(config.roomId)}/members/${
                        encodeURIComponent(authSession.clientId)
                    }`
                );
        });
        await panel.getByRole('button', { name: 'Send' }).click();
        const emptyBodyResponse = await emptyBodyResponsePromise;

        expect(emptyBodyResponse.status()).toBe(400);
        await expectResponseStatus(panel, [400]);

        const wrongPrincipalId = `${authSession.clientId}-not-self-${suffix}`;
        await panel.getByLabel('Endpoint').selectOption('group-member-join');
        await panel.getByRole('textbox', { name: 'Path' }).fill(
            `${scopePath}/groups/${encodeURIComponent(config.roomId)}/members/${
                encodeURIComponent(wrongPrincipalId)
            }/requests/full-stack-mismatch-${suffix}`
        );

        const mismatchResponsePromise = page.waitForResponse((response) => {
            const request = response.request();
            const url = new URL(response.url());
            return request.method() === 'PUT' &&
                url.origin === config.apiBaseUrl &&
                isStrictMutationPath(
                    url.pathname,
                    `${scopePath}/groups/${encodeURIComponent(config.roomId)}/members/${
                        encodeURIComponent(wrongPrincipalId)
                    }`
                );
        });
        await panel.getByRole('button', { name: 'Send' }).click();
        const mismatchResponse = await mismatchResponsePromise;

        expect(mismatchResponse.status()).toBe(403);
        await expectResponseStatus(panel, [403]);
        await expect(panel).toContainText('principal id does not match authenticated client');
    });

    test('runs a live REST collection for create-or-existing group and join', async ({ page, request }) => {
        test.setTimeout(120_000);
        await expectFullStackApiReady(request, config);

        const suffix = uniqueSuffix();
        await loginThroughUi(page, config, config.userA, {
            suffix: `group-collection-${suffix}`,
            tab: 'rallar-server'
        });
        const authSession = await readBrowserAuthSession(page);
        const panel = page.locator('#panel-rallar-server');
        const scopePath = stateScopePath();

        await ensureGroupExists(panel, request, authSession, scopePath);

        await panel.getByLabel('Variables JSON').fill(JSON.stringify(
            {
                applicationId: config.applicationId,
                workspaceId: config.workspaceId,
                groupId: config.roomId,
                principalId: authSession.clientId,
                requestId: `full-stack-collection-${suffix}`
            },
            null,
            2
        ));
        await panel.getByLabel('Collection JSON').fill(JSON.stringify(
            {
                collectionId: 'live-login-join-existing-group',
                name: 'Live login and join existing group',
                steps: [
                    {
                        stepId: 'read-existing-group-before-join',
                        label: 'Read existing group before join',
                        request: {
                            method: 'GET',
                            path: '/api/state/apps/{{applicationId}}/workspaces/{{workspaceId}}/groups/{{groupId}}',
                            attachAuth: true,
                            responseBodyMode: 'json'
                        },
                        expect: { status: 200 }
                    },
                    {
                        stepId: 'join-group-as-authenticated-client',
                        label: 'Join group as authenticated client',
                        request: {
                            method: 'PUT',
                            path: '/api/state/apps/{{applicationId}}/workspaces/{{workspaceId}}/groups/{{groupId}}' +
                                '/members/{{principalId}}/requests/{{requestId}}',
                            attachAuth: true,
                            responseBodyMode: 'json',
                            body: { status: 'active' }
                        },
                        expect: { status: [200, 201] }
                    },
                    {
                        stepId: 'read-group-after-join',
                        label: 'Read group after join',
                        request: {
                            method: 'GET',
                            path: '/api/state/apps/{{applicationId}}/workspaces/{{workspaceId}}/groups/{{groupId}}',
                            attachAuth: true,
                            responseBodyMode: 'json'
                        },
                        expect: {
                            status: 200,
                            body: [
                                { path: '$.group.groupId', equals: '{{groupId}}' }
                            ]
                        },
                        extract: [
                            { name: 'observedGroupId', path: '$.group.groupId' }
                        ]
                    }
                ]
            },
            null,
            2
        ));

        await panel.getByRole('button', { name: 'Run Collection' }).click();

        await expect(panel).toContainText('Read existing group before join');
        await expect(panel).toContainText('Join group as authenticated client');
        await expect(panel).toContainText('Read group after join');
        await expect(panel.getByLabel('Variables JSON')).toHaveValue(
            new RegExp(`"observedGroupId":\\s*"${escapeRegExp(config.roomId)}"`)
        );
    });
});

function stateScopePath(): string {
    return `/api/state/apps/${encodeURIComponent(config.applicationId)}/workspaces/${
        encodeURIComponent(config.workspaceId)
    }`;
}

async function ensureGroupExists(
    panel: Locator,
    request: APIRequestContext,
    authSession: BrowserAuthSession,
    scopePath: string
): Promise<void> {
    const readResponse = await request.get(
        `${config.apiBaseUrl}${scopePath}/groups/${encodeURIComponent(config.roomId)}`,
        { headers: authHeaders(authSession) }
    );
    if (readResponse.status() === 200) {
        return;
    }
    if (readResponse.status() !== 404) {
        throw new Error(
            `Expected existing-group setup read to return 200 or 404, got HTTP ${readResponse.status()}: ${await readResponse
                .text()}`
        );
    }
    await createGroupFromWorkbench(panel, authSession, scopePath);
}

async function createGroupFromWorkbench(
    panel: Locator,
    authSession: BrowserAuthSession,
    scopePath: string
): Promise<void> {
    await panel.getByLabel('Endpoint').selectOption('group-create');
    await panel.getByLabel('Body JSON').fill(JSON.stringify(
        {
            groupId: config.roomId,
            displayName: config.roomId,
            description: 'Created by full-stack Rallar Server REST workbench test',
            kind: 'room',
            joinMode: 'open',
            createdByPrincipalId: authSession.clientId
        },
        null,
        2
    ));

    const createResponsePromise = panel.page().waitForResponse((response) => {
        const request = response.request();
        const url = new URL(response.url());
        return request.method() === 'POST' &&
            url.origin === config.apiBaseUrl &&
            isStrictMutationPath(url.pathname, `${scopePath}/groups`);
    });
    await panel.getByRole('button', { name: 'Send' }).click();
    const createResponse = await createResponsePromise;
    if (![200, 201, 409].includes(createResponse.status())) {
        throw new Error(
            `Expected group setup create to return 200, 201, or 409, got HTTP ${createResponse.status()}: ${await createResponse
                .text()}`
        );
    }
}

function isStrictMutationPath(path: string, mutationPath: string): boolean {
    const prefix = `${mutationPath}/requests/`;
    const requestId = path.startsWith(prefix) ? path.slice(prefix.length) : '';
    return /^[A-Za-z0-9_-]{20,128}$/u.test(requestId);
}

function authHeaders(authSession: BrowserAuthSession): Record<string, string> {
    return {
        accept: 'application/json',
        authorization: `Bearer ${authSession.accessToken}`,
        'x-client-id': authSession.clientId
    };
}

async function expectResponseStatus(
    panel: Locator,
    statuses: readonly number[]
): Promise<void> {
    await expect.poll(async () => {
        const text = await panel.locator('.result-summary div').filter({ hasText: 'Status' })
            .locator('dd')
            .textContent();
        const match = text?.match(statusMatcher);
        return match ? statuses.includes(Number(match[1])) : false;
    }).toBe(true);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
