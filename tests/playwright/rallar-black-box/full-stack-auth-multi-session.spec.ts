import {
    expect,
    test,
    type BrowserContext,
    type Page
} from '@playwright/test';
import type { JSHandle } from '@playwright/test';

import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { decodeApiConfigResponse } from '@shared-web/browser/connection/decode-api-config-response.ts';
import type { WebSocketTicketResponse } from '@shared/api/api-config.ts';

import {
    expectFullStackApiReady,
    loginUser,
    readFullStackConfig,
    uniqueSuffix
} from './full-stack-helpers.ts';
import { readBrowserAuthSession } from './full-stack-helpers.ts';

interface WsOpenResult {
    readonly opened: boolean;
    readonly sessionId: string;
}

interface WsCloseRecord {
    readonly code: number;
    readonly reason: string;
}

interface HeldApiWebSocket {
    readonly socket: WebSocket;
    readonly closes: WsCloseRecord[];
    readonly result: WsOpenResult;
}

interface PreparedApiWebSocket {
    readonly url: string;
    readonly sessionId: string;
}

interface WsTicketResult {
    readonly status: number;
    readonly sessionId?: string;
}

const config = readFullStackConfig();

test.describe('full-stack same-user multi-session auth', () => {
    test.skip(!config.enabled, config.skipReason);

    test('logout and authenticated websocket lifecycle are isolated per browser session', async ({ browser, request }) => {
        test.setTimeout(120_000);
        await expectFullStackApiReady(request, config);

        const suffix = uniqueSuffix();
        const groupId = `${config.roomId}-auth-multi-${suffix}`;
        const contextA = await browser.newContext();
        let contextB: BrowserContext | undefined;
        let held: JSHandle<HeldApiWebSocket> | undefined;
        try {
            contextB = await browser.newContext();
            const pageA = await contextA.newPage();
            const pageB = await contextB.newPage();
            const sessionA = await loginUser({
                page: pageA,
                config,
                user: config.userA,
                groupId,
                sessionId: `${config.userA.actor}-same-user-a-${suffix}`,
                tab: 'auth'
            });
            const sessionB = await loginUser({
                page: pageB,
                config,
                user: config.userA,
                groupId,
                sessionId: `${config.userA.actor}-same-user-b-${suffix}`,
                tab: 'auth'
            });

            expect(sessionA.clientId).toBe(sessionB.clientId);
            expect(sessionA.username).toBe(sessionB.username);
            expect(sessionA.sessionId).not.toBe(sessionB.sessionId);
            expect(sessionA.accessToken).not.toBe(sessionB.accessToken);

            const heldSocket = await openHeldApiWebSocket(pageA, config.apiBaseUrl);
            held = heldSocket;
            await expect(held.evaluate((probe) => probe.result)).resolves.toMatchObject({
                opened: true,
                sessionId: sessionA.sessionId
            });
            await expect(createWsTicket(pageB, config.apiBaseUrl)).resolves.toMatchObject({
                status: 200,
                sessionId: sessionB.sessionId
            });

            await expect(logoutWithStoredSession(pageA, config.apiBaseUrl)).resolves.toBe(200);
            await expect.poll(() => heldSocket.evaluate((probe) => probe.closes), {
                timeout: 15_000
            }).toEqual([
                {
                    code: 1000,
                    reason: 'auth-logout'
                }
            ]);

            await expect(createWsTicket(pageA, config.apiBaseUrl)).resolves.toMatchObject({
                status: 401
            });
            await expect(createWsTicket(pageB, config.apiBaseUrl)).resolves.toMatchObject({
                status: 200,
                sessionId: sessionB.sessionId
            });
            await expect(openApiWebSocketOnce(pageB, config.apiBaseUrl)).resolves.toMatchObject({
                opened: true,
                sessionId: sessionB.sessionId
            });
        }
        finally {
            try {
                if (held !== undefined) {
                    await held.evaluate((probe) => probe.socket.close(1000, 'test-complete'));
                    await held.dispose();
                }
            }
            finally {
                await Promise.all([contextA.close(), contextB?.close()]);
            }
        }
    });
});

function readWsTicketResponse(value: unknown): WebSocketTicketResponse {
    if (
        !isJsonRecordValue(value) || typeof value.ticket !== 'string' || value.ticket.length === 0 ||
        typeof value.sessionId !== 'string' || value.sessionId.length === 0 ||
        typeof value.expiresAtEpochMs !== 'number' || !Number.isFinite(value.expiresAtEpochMs)
    ) {
        throw new Error('Invalid API WS ticket response.');
    }
    return { ticket: value.ticket, sessionId: value.sessionId, expiresAtEpochMs: value.expiresAtEpochMs };
}

async function createWsTicket(page: Page, apiBaseUrl: string): Promise<WsTicketResult> {
    const session = await readBrowserAuthSession(page);
    const response = await page.evaluate(async ({ baseUrl, session }) => {
        const response = await fetch(`${baseUrl}/api/auth/ws-ticket/requests/${crypto.randomUUID()}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${session.accessToken}`, 'x-client-id': session.clientId }
        });
        return { status: response.status, body: await response.json() as unknown };
    }, { baseUrl: apiBaseUrl, session });
    if (response.status !== 200) {
        return { status: response.status };
    }
    const body = response.body;
    return { status: response.status, sessionId: readWsTicketResponse(body).sessionId };
}

async function logoutWithStoredSession(page: Page, apiBaseUrl: string): Promise<number> {
    const session = await readBrowserAuthSession(page);
    return await page.evaluate(async ({ baseUrl, session }) => {
        const response = await fetch(`${baseUrl}/api/auth/logout/requests/${crypto.randomUUID()}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${session.accessToken}`, 'x-client-id': session.clientId }
        });
        return response.status;
    }, { baseUrl: apiBaseUrl, session });
}

async function prepareApiWebSocket(page: Page, apiBaseUrl: string): Promise<PreparedApiWebSocket> {
    const session = await readBrowserAuthSession(page);
    const response = await page.evaluate(async ({ baseUrl, session }) => {
        const [config, ticket] = await Promise.all([
            fetch(`${baseUrl}/api/config`),
            fetch(`${baseUrl}/api/auth/ws-ticket/requests/${crypto.randomUUID()}`, {
                method: 'POST',
                headers: { authorization: `Bearer ${session.accessToken}`, 'x-client-id': session.clientId }
            })
        ]);
        if (!config.ok || !ticket.ok) {
            throw new Error(`Failed API config/WS ticket: ${config.status}/${ticket.status}`);
        }
        return { config: await config.json() as unknown, ticket: await ticket.json() as unknown };
    }, { baseUrl: apiBaseUrl, session });
    const config = decodeApiConfigResponse(response.config).fold(
        (issue) => {
            throw new Error(issue);
        },
        (config) => config
    );
    const ticket = readWsTicketResponse(response.ticket);
    const url = new URL(`/api/ws/${encodeURIComponent(session.sessionId)}`, `${config.wsBaseUrl.replace(/\/+$/, '')}/`);
    url.searchParams.set('ticket', ticket.ticket);
    return { url: url.toString(), sessionId: session.sessionId };
}

async function openHeldApiWebSocket(page: Page, apiBaseUrl: string): Promise<JSHandle<HeldApiWebSocket>> {
    const input = await prepareApiWebSocket(page, apiBaseUrl);
    return await page.evaluateHandle(async ({ url, sessionId }) => {
        const socket = new WebSocket(url);
        const closes: WsCloseRecord[] = [];
        socket.onclose = (event) => closes.push({ code: event.code, reason: event.reason });
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                socket.close(1000, 'test-timeout');
                reject(new Error('Timed out waiting for held API WebSocket open.'));
            }, 15_000);
            socket.onopen = () => {
                clearTimeout(timeout);
                resolve();
            };
            socket.onerror = () => {
                clearTimeout(timeout);
                socket.close(1000, 'test-error');
                reject(new Error('Held API WebSocket failed to open.'));
            };
        });
        return { socket, closes, result: { opened: true, sessionId } };
    }, input);
}

async function openApiWebSocketOnce(page: Page, apiBaseUrl: string): Promise<WsOpenResult> {
    const held = await openHeldApiWebSocket(page, apiBaseUrl);
    try {
        return await held.evaluate((probe) => probe.result);
    }
    finally {
        await held.evaluate((probe) => probe.socket.close(1000, 'test-complete'));
        await held.dispose();
    }
}
