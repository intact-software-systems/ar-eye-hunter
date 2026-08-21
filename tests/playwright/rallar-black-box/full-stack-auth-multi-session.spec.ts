import { expect, type Page, test } from '@playwright/test';
import {
    expectFullStackApiReady,
    loginUser,
    readFullStackConfig,
    uniqueSuffix,
} from './full-stack-helpers.ts';

const config = readFullStackConfig();

type BrowserAuthSession = Readonly<{
    clientId: string;
    accessToken: string;
    username: string;
    sessionId: string;
}>;

type WsOpenResult = Readonly<{
    opened: boolean;
    sessionId: string;
}>;

type WsCloseRecord = Readonly<{
    code: number;
    reason: string;
}>;

test.describe('full-stack same-user multi-session auth', () => {
    test.skip(!config.enabled, config.skipReason);

    test('logout and authenticated websocket lifecycle are isolated per browser session', async ({
        browser,
        request,
    }) => {
        test.setTimeout(120_000);
        await expectFullStackApiReady(request, config);

        const suffix = uniqueSuffix();
        const groupId = `${config.roomId}-auth-multi-${suffix}`;
        const contextA = await browser.newContext();
        const contextB = await browser.newContext();
        const pageA = await contextA.newPage();
        const pageB = await contextB.newPage();

        try {
            const sessionA = await loginUser(pageA, config, config.userA, {
                groupId,
                sessionId: `${config.userA.actor}-same-user-a-${suffix}`,
                tab: 'auth',
            });
            const sessionB = await loginUser(pageB, config, config.userA, {
                groupId,
                sessionId: `${config.userA.actor}-same-user-b-${suffix}`,
                tab: 'auth',
            });

            expect(sessionA.clientId).toBe(sessionB.clientId);
            expect(sessionA.username).toBe(sessionB.username);
            expect(sessionA.sessionId).not.toBe(sessionB.sessionId);
            expect(sessionA.accessToken).not.toBe(sessionB.accessToken);

            await expect(openHeldApiWebSocket(pageA, config.apiBaseUrl)).resolves.toMatchObject({
                opened: true,
                sessionId: sessionA.sessionId,
            });
            await expect(createWsTicket(pageB, config.apiBaseUrl)).resolves.toMatchObject({
                status: 200,
                sessionId: sessionB.sessionId,
            });

            await expect(logoutWithStoredSession(pageA, config.apiBaseUrl)).resolves.toBe(200);
            await expect.poll(() => readHeldSocketCloseRecords(pageA), {
                timeout: 15_000,
            }).toEqual([
                {
                    code: 1000,
                    reason: 'auth-logout',
                },
            ]);

            await expect(createWsTicket(pageA, config.apiBaseUrl)).resolves.toMatchObject({
                status: 401,
            });
            await expect(createWsTicket(pageB, config.apiBaseUrl)).resolves.toMatchObject({
                status: 200,
                sessionId: sessionB.sessionId,
            });
            await expect(openApiWebSocketOnce(pageB, config.apiBaseUrl)).resolves.toMatchObject({
                opened: true,
                sessionId: sessionB.sessionId,
            });
        } finally {
            await Promise.all([
                contextA.close(),
                contextB.close(),
            ]);
        }
    });
});

async function createWsTicket(
    page: Page,
    apiBaseUrl: string,
): Promise<Readonly<{ status: number; sessionId?: string }>> {
    return await page.evaluate(async (baseUrl) => {
        const raw = window.localStorage.getItem('auth.session');
        if (!raw) {
            throw new Error('Missing auth.session in localStorage.');
        }
        const session = JSON.parse(raw) as BrowserAuthSession;
        const requestId = crypto.randomUUID();
        const response = await fetch(`${baseUrl}/api/auth/ws-ticket/requests/${requestId}`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${session.accessToken}`,
                'x-client-id': session.clientId,
            },
        });
        const body = await response.json().catch(() => undefined) as
            | { sessionId?: string }
            | undefined;
        return {
            status: response.status,
            sessionId: body?.sessionId,
        };
    }, apiBaseUrl);
}

async function logoutWithStoredSession(page: Page, apiBaseUrl: string): Promise<number> {
    return await page.evaluate(async (baseUrl) => {
        const raw = window.localStorage.getItem('auth.session');
        if (!raw) {
            throw new Error('Missing auth.session in localStorage.');
        }
        const session = JSON.parse(raw) as BrowserAuthSession;
        const requestId = crypto.randomUUID();
        const response = await fetch(`${baseUrl}/api/auth/logout/requests/${requestId}`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${session.accessToken}`,
                'x-client-id': session.clientId,
            },
        });
        return response.status;
    }, apiBaseUrl);
}

async function openHeldApiWebSocket(
    page: Page,
    apiBaseUrl: string,
): Promise<WsOpenResult> {
    return await page.evaluate(async (baseUrl) => {
        const win = window as Window & {
            __authMultiSessionSocket?: WebSocket;
            __authMultiSessionSocketCloses?: WsCloseRecord[];
        };
        win.__authMultiSessionSocketCloses = [];

        const raw = window.localStorage.getItem('auth.session');
        if (!raw) {
            throw new Error('Missing auth.session in localStorage.');
        }
        const session = JSON.parse(raw) as BrowserAuthSession;
        const [apiConfigResponse, ticketResponse] = await Promise.all([
            fetch(`${baseUrl}/api/config`),
            fetch(`${baseUrl}/api/auth/ws-ticket/requests/${crypto.randomUUID()}`, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${session.accessToken}`,
                    'x-client-id': session.clientId,
                },
            }),
        ]);
        if (!apiConfigResponse.ok) {
            throw new Error(`Failed to fetch API config: ${apiConfigResponse.status}`);
        }
        if (!ticketResponse.ok) {
            throw new Error(`Failed to create WS ticket: ${ticketResponse.status}`);
        }
        const apiConfig = await apiConfigResponse.json() as { wsBaseUrl?: string };
        const ticket = await ticketResponse.json() as { ticket: string };
        if (!apiConfig.wsBaseUrl) {
            throw new Error('API config did not include wsBaseUrl.');
        }
        const url = new URL(
            `/api/ws/${encodeURIComponent(session.sessionId)}`,
            `${apiConfig.wsBaseUrl.replace(/\/+$/, '')}/`,
        );
        url.searchParams.set('ticket', ticket.ticket);

        return await new Promise<WsOpenResult>((resolve, reject) => {
            const socket = new WebSocket(url.toString());
            win.__authMultiSessionSocket = socket;
            const timeout = window.setTimeout(() => {
                reject(new Error('Timed out waiting for held API WebSocket open.'));
            }, 15_000);

            socket.onopen = () => {
                window.clearTimeout(timeout);
                resolve({
                    opened: true,
                    sessionId: session.sessionId,
                });
            };
            socket.onerror = () => {
                window.clearTimeout(timeout);
                reject(new Error('Held API WebSocket failed to open.'));
            };
            socket.onclose = (event) => {
                win.__authMultiSessionSocketCloses?.push({
                    code: event.code,
                    reason: event.reason,
                });
            };
        });
    }, apiBaseUrl);
}

async function openApiWebSocketOnce(
    page: Page,
    apiBaseUrl: string,
): Promise<WsOpenResult> {
    return await page.evaluate(async (baseUrl) => {
        const raw = window.localStorage.getItem('auth.session');
        if (!raw) {
            throw new Error('Missing auth.session in localStorage.');
        }
        const session = JSON.parse(raw) as BrowserAuthSession;
        const [apiConfigResponse, ticketResponse] = await Promise.all([
            fetch(`${baseUrl}/api/config`),
            fetch(`${baseUrl}/api/auth/ws-ticket/requests/${crypto.randomUUID()}`, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${session.accessToken}`,
                    'x-client-id': session.clientId,
                },
            }),
        ]);
        if (!apiConfigResponse.ok) {
            throw new Error(`Failed to fetch API config: ${apiConfigResponse.status}`);
        }
        if (!ticketResponse.ok) {
            throw new Error(`Failed to create WS ticket: ${ticketResponse.status}`);
        }
        const apiConfig = await apiConfigResponse.json() as { wsBaseUrl?: string };
        const ticket = await ticketResponse.json() as { ticket: string };
        if (!apiConfig.wsBaseUrl) {
            throw new Error('API config did not include wsBaseUrl.');
        }
        const url = new URL(
            `/api/ws/${encodeURIComponent(session.sessionId)}`,
            `${apiConfig.wsBaseUrl.replace(/\/+$/, '')}/`,
        );
        url.searchParams.set('ticket', ticket.ticket);

        return await new Promise<WsOpenResult>((resolve, reject) => {
            const socket = new WebSocket(url.toString());
            const timeout = window.setTimeout(() => {
                socket.close(1000, 'test-timeout');
                reject(new Error('Timed out waiting for API WebSocket open.'));
            }, 15_000);

            socket.onopen = () => {
                window.clearTimeout(timeout);
                socket.close(1000, 'test-complete');
                resolve({
                    opened: true,
                    sessionId: session.sessionId,
                });
            };
            socket.onerror = () => {
                window.clearTimeout(timeout);
                reject(new Error('API WebSocket failed to open.'));
            };
        });
    }, apiBaseUrl);
}

async function readHeldSocketCloseRecords(page: Page): Promise<readonly WsCloseRecord[]> {
    return await page.evaluate(() => {
        const win = window as Window & {
            __authMultiSessionSocketCloses?: WsCloseRecord[];
        };
        return win.__authMultiSessionSocketCloses ?? [];
    });
}
