import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    expectFullStackApiReady,
    loginThroughUi,
    readFullStackConfig,
    uniqueSuffix,
} from './full-stack-helpers.ts';

const config = readFullStackConfig();
const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../..',
);
const rallarModuleUrl =
    `/@fs${path.join(repoRoot, 'packages/shared-web/browser/rallar.ts')}`;

type BrowserAuthSession = Readonly<{
    clientId: string;
    accessToken: string;
    username: string;
    sessionId: string;
    expiresAtEpochMs: number;
}>;

type ClientSessionSnapshot = Readonly<{
    sessionId?: string;
    status?: string;
}>;

type ClientSnapshot = Readonly<{
    activeSessions?: readonly ClientSessionSnapshot[];
}>;

type ClientEvent = Readonly<{
    eventType?: string;
    sessionId?: string;
}>;

type CapturedMutationRequest = Readonly<{
    requestId?: string;
    groupId?: string;
}>;

test.describe('full-stack Browser Rallar resilience', () => {
    test.skip(!config.enabled, config.skipReason);

    test('retries transient room create and presence connect failures with stable request IDs', async ({
        page,
        request,
    }) => {
        test.setTimeout(120_000);
        await expectFullStackApiReady(request, config);

        const suffix = uniqueSuffix();
        const createRequests: CapturedMutationRequest[] = [];
        const presenceRequests: CapturedMutationRequest[] = [];
        let createFailedOnce = false;
        let presenceFailedOnce = false;

        await loginThroughUi(page, config, config.userA, {
            suffix: `retry-${suffix}`,
            tab: 'manual-rallar',
        });

        await page.route(
            '**/api/state/apps/ar-eye-hunter/workspaces/default/groups',
            async (route) => {
                if (route.request().method() === 'POST') {
                    createRequests.push(readJsonBody(route.request().postData()));
                    if (!createFailedOnce) {
                        createFailedOnce = true;
                        await fulfillTransient(route, 503, 'transient group create failure');
                        return;
                    }
                }

                await route.continue();
            },
        );

        await page.route(
            /\/api\/state\/apps\/ar-eye-hunter\/workspaces\/default\/groups\/[^/]+\/sessions\/[^/]+$/,
            async (route) => {
                if (route.request().method() === 'PUT') {
                    presenceRequests.push(readJsonBody(route.request().postData()));
                    if (!presenceFailedOnce) {
                        presenceFailedOnce = true;
                        await fulfillTransient(route, 429, 'transient presence rate limit');
                        return;
                    }
                }

                await route.continue();
            },
        );

        const result = await page.evaluate(
            async ({ apiBaseUrl, moduleUrl, roomName }) => {
                const { rallar } = await import(moduleUrl);
                rallar.configure({ apiBaseUrl });
                rallar.setDefaults({
                    applicationId: 'ar-eye-hunter',
                    workspaceId: 'default',
                });

                const session = rallar.session();
                if (!session) {
                    throw new Error('Expected a browser Rallar session after UI login.');
                }

                const snapshot = await rallar.rooms.create({
                    displayName: roomName,
                    maxAttempts: 3,
                    timeoutMs: 20_000,
                });

                return {
                    groupId: snapshot.group.groupId,
                    sessionId: session.sessionId,
                    activeSessionIds: snapshot.activeSessions.map((entry: { sessionId: string }) =>
                        entry.sessionId
                    ),
                };
            },
            {
                apiBaseUrl: config.apiBaseUrl,
                moduleUrl: rallarModuleUrl,
                roomName: `Retry Room ${suffix}`,
            },
        );

        expect(createRequests).toHaveLength(2);
        expect(createRequests[0].requestId).toBeTruthy();
        expect(createRequests[1].requestId).toBe(createRequests[0].requestId);
        expect(createRequests[1].groupId).toBe(createRequests[0].groupId);
        expect(presenceRequests).toHaveLength(2);
        expect(presenceRequests[0].requestId).toBeTruthy();
        expect(presenceRequests[1].requestId).toBe(presenceRequests[0].requestId);
        expect(result.activeSessionIds).toContain(result.sessionId);

        const session = await readBrowserSession(page);
        const persisted = await getGroupSnapshot(
            request,
            result.groupId,
            session,
        );
        expect(persisted.group.groupId).toBe(result.groupId);
    });

    test('disconnects WS client state when API logout deletes auth before socket close', async ({
        page,
        request,
    }) => {
        test.setTimeout(120_000);
        await expectFullStackApiReady(request, config);

        const suffix = uniqueSuffix();
        await loginThroughUi(page, config, config.userA, {
            suffix: `logout-race-${suffix}`,
            tab: 'manual-rallar',
        });

        const connected = await page.evaluate(
            async ({ apiBaseUrl, moduleUrl }) => {
                const { rallar } = await import(moduleUrl);
                rallar.configure({ apiBaseUrl });
                const session = rallar.session();
                if (!session) {
                    throw new Error('Expected a browser Rallar session after UI login.');
                }

                await rallar.connect({ timeoutMs: 20_000 });

                return {
                    clientId: session.clientId,
                    sessionId: session.sessionId,
                    accessToken: session.accessToken,
                };
            },
            {
                apiBaseUrl: config.apiBaseUrl,
                moduleUrl: rallarModuleUrl,
            },
        );

        await expect.poll(async () => {
            const snapshot = await getClientSnapshot(
                request,
                connected.clientId,
                {
                    clientId: connected.clientId,
                    accessToken: connected.accessToken,
                    username: config.userA.username,
                    sessionId: connected.sessionId,
                    expiresAtEpochMs: Date.now() + 60_000,
                },
            );
            return hasActiveSession(snapshot, connected.sessionId);
        }, {
            timeout: 30_000,
        }).toBe(true);

        const logoutStatus = await page.evaluate(
            async ({ apiBaseUrl }) => {
                const raw = localStorage.getItem('auth.session');
                if (!raw) {
                    throw new Error('Expected auth.session in browser localStorage.');
                }
                const session = JSON.parse(raw) as BrowserAuthSession;
                const response = await fetch(`${apiBaseUrl}/api/auth/logout`, {
                    method: 'POST',
                    headers: {
                        'authorization': `Bearer ${session.accessToken}`,
                        'content-type': 'application/json',
                        'x-client-id': session.clientId,
                    },
                    body: JSON.stringify({}),
                });
                return response.status;
            },
            { apiBaseUrl: config.apiBaseUrl },
        );
        expect(logoutStatus).toBe(200);

        const closeResult = await page.evaluate(
            async ({ moduleUrl }) => {
                const { rallar } = await import(moduleUrl);
                const before = rallar.ws.status();
                rallar.advanced.middleware().middleware.webSocketQueueBox.close(
                    1000,
                    'auth-deleted-before-close-test',
                );
                localStorage.removeItem('auth.session');
                return {
                    readyStateBeforeClose: before.readyState,
                    reconnectEnabledBeforeClose: before.reconnectEnabled,
                };
            },
            { moduleUrl: rallarModuleUrl },
        );
        expect(closeResult.readyStateBeforeClose).toBe('open');

        const freshSession = await loginViaApi(request);
        await expect.poll(async () => {
            const [snapshot, events] = await Promise.all([
                getClientSnapshot(request, connected.clientId, freshSession),
                getClientEvents(request, connected.clientId, freshSession),
            ]);

            return {
                oldSessionStillActive: hasActiveSession(snapshot, connected.sessionId),
                disconnectedEvent: events.some((event) =>
                    event.eventType === 'session-disconnected' &&
                    event.sessionId === connected.sessionId
                ),
            };
        }, {
            timeout: 45_000,
        }).toEqual({
            oldSessionStillActive: false,
            disconnectedEvent: true,
        });
    });
});

function readJsonBody(raw: string | null): CapturedMutationRequest {
    if (!raw) {
        return {};
    }

    return JSON.parse(raw) as CapturedMutationRequest;
}

async function fulfillTransient(
    route: Route,
    status: number,
    body: string,
): Promise<void> {
    const origin = route.request().headers().origin ?? 'http://localhost:5176';
    await route.fulfill({
        status,
        contentType: 'text/plain',
        headers: {
            'access-control-allow-credentials': 'true',
            'access-control-allow-origin': origin,
        },
        body,
    });
}

async function readBrowserSession(page: Page): Promise<BrowserAuthSession> {
    return await page.evaluate(() => {
        const raw = localStorage.getItem('auth.session');
        if (!raw) {
            throw new Error('Expected auth.session in browser localStorage.');
        }
        return JSON.parse(raw);
    }) as BrowserAuthSession;
}

async function loginViaApi(
    request: APIRequestContext,
): Promise<BrowserAuthSession> {
    const response = await request.post(`${config.apiBaseUrl}/api/auth/login`, {
        data: {
            username: config.userA.username,
            password: config.userA.password,
        },
    });
    expect(response.ok()).toBe(true);
    return await response.json() as BrowserAuthSession;
}

async function getGroupSnapshot(
    request: APIRequestContext,
    groupId: string,
    session: BrowserAuthSession,
): Promise<{ group: { groupId: string } }> {
    const response = await request.get(
        `${config.apiBaseUrl}/api/state/apps/ar-eye-hunter/workspaces/default/groups/${
            encodeURIComponent(groupId)
        }`,
        { headers: authHeaders(session) },
    );
    expect(response.ok()).toBe(true);
    return await response.json() as { group: { groupId: string } };
}

async function getClientSnapshot(
    request: APIRequestContext,
    clientId: string,
    session: BrowserAuthSession,
): Promise<ClientSnapshot> {
    const response = await request.get(
        `${config.apiBaseUrl}/api/state/apps/ar-eye-hunter/workspaces/default/clients/${
            encodeURIComponent(clientId)
        }`,
        { headers: authHeaders(session) },
    );
    expect(response.ok()).toBe(true);
    return await response.json() as ClientSnapshot;
}

async function getClientEvents(
    request: APIRequestContext,
    clientId: string,
    session: BrowserAuthSession,
): Promise<readonly ClientEvent[]> {
    const response = await request.get(
        `${config.apiBaseUrl}/api/state/apps/ar-eye-hunter/workspaces/default/clients/${
            encodeURIComponent(clientId)
        }/events`,
        { headers: authHeaders(session) },
    );
    expect(response.ok()).toBe(true);
    return await response.json() as readonly ClientEvent[];
}

function authHeaders(
    session: Pick<BrowserAuthSession, 'accessToken' | 'clientId'>,
): Record<string, string> {
    return {
        authorization: `Bearer ${session.accessToken}`,
        'x-client-id': session.clientId,
    };
}

function hasActiveSession(
    snapshot: ClientSnapshot,
    sessionId: string,
): boolean {
    return snapshot.activeSessions?.some((session) =>
        session.sessionId === sessionId &&
        session.status === 'active'
    ) ?? false;
}
