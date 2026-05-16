import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const FULL_STACK_CONTROL_BASE_URL = 'http://127.0.0.1:5180';
export const FULL_STACK_CONTROL_WS_URL = 'ws://127.0.0.1:5180/control';
export const FULL_STACK_SPA_ORIGIN = 'http://localhost:5176';

export type FullStackUser = Readonly<{
    username: string;
    password: string;
    clientId: string;
    actor: string;
}>;

export type FullStackConfig = Readonly<{
    enabled: boolean;
    skipReason: string;
    apiBaseUrl: string;
    roomId: string;
    userA: FullStackUser;
    userB: FullStackUser;
}>;

type ControlResult = Readonly<{
    commandId?: string;
    ok?: boolean;
    result?: unknown;
}>;

type ControlRunSnapshot = Readonly<{
    results?: readonly ControlResult[];
    events?: readonly unknown[];
    stats?: readonly unknown[];
    reports?: readonly unknown[];
}>;

export function readFullStackConfig(): FullStackConfig {
    const enabled = process.env.RALLAR_BLACK_BOX_FULL_STACK === '1' ||
        process.env.RALLAR_BLACK_BOX_FULL_STACK === 'true';

    return {
        enabled,
        skipReason: 'Set RALLAR_BLACK_BOX_FULL_STACK=1 and provide a working root .env/DATABASE_URL for apps/api-v1 to run full-stack Rallar Black Box tests.',
        apiBaseUrl: normalizeBaseUrl(envValue('VITE_RALLAR_API_BASE_URL') ?? 'http://localhost:8080'),
        roomId: envValue('VITE_RALLAR_ROOM_ID') ?? `rallar-bb-full-stack-${Date.now()}`,
        userA: {
            username: envValue('VITE_RALLAR_USERNAME') ?? 'alice',
            password: envValue('VITE_RALLAR_PASSWORD') ?? 'secret',
            clientId: envValue('VITE_RALLAR_CLIENT_ID') ??
                envValue('VITE_RALLAR_USERNAME') ??
                'alice',
            actor: envValue('VITE_RALLAR_ACTOR') ?? 'alice',
        },
        userB: {
            username: envValue('VITE_RALLAR_B_USERNAME') ?? 'bob',
            password: envValue('VITE_RALLAR_B_PASSWORD') ?? 'secret',
            clientId: envValue('VITE_RALLAR_B_CLIENT_ID') ??
                envValue('VITE_RALLAR_B_USERNAME') ??
                'bob',
            actor: envValue('VITE_RALLAR_B_ACTOR') ?? 'bob',
        },
    };
}

export async function expectFullStackApiReady(
    request: APIRequestContext,
    config: FullStackConfig,
): Promise<void> {
    const configResponse = await request.get(`${config.apiBaseUrl}/api/config`, {
        headers: {
            origin: FULL_STACK_SPA_ORIGIN,
        },
    });
    expect(configResponse.ok()).toBe(true);
    expect(configResponse.headers()['access-control-allow-origin']).toBe(FULL_STACK_SPA_ORIGIN);
}

export async function loginThroughUi(
    page: Page,
    config: FullStackConfig,
    user: FullStackUser,
    input: Readonly<{
        suffix: string;
        tab?: 'manual-rallar' | 'rallar-server' | 'event-stream' | 'local-workbench';
    }>,
): Promise<void> {
    const sessionId = `${user.actor}-session-${input.suffix}`;
    const query = new URLSearchParams({
        provider: 'browser-rallar',
        apiBaseUrl: config.apiBaseUrl,
        roomId: config.roomId,
        actor: user.actor,
        sessionId,
        tab: input.tab ?? 'rallar-server',
    });

    await page.goto(`/?${query.toString()}`);
    await expect(page.getByRole('heading', { name: 'Rallar Server Login' })).toBeVisible();
    await page.getByLabel('API Base URL').fill(config.apiBaseUrl);
    await page.getByLabel('Username').fill(user.username);
    await page.getByLabel('Password').fill(user.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('tab', { name: 'Rallar Server' })).toBeVisible();
    await expect(page.locator('.run-header')).toContainText(user.username);
}

export async function sendWsTicketFromRestWorkbench(
    page: Page,
    config: FullStackConfig,
): Promise<Readonly<Record<string, string>>> {
    const requestPromise = page.waitForRequest(request =>
        request.url() === `${config.apiBaseUrl}/api/auth/ws-ticket` &&
        request.method() === 'POST'
    );
    const panel = page.locator('#panel-rallar-server');

    await page.getByRole('tab', { name: 'Rallar Server' }).click();
    await panel.getByLabel('Endpoint').selectOption('auth-ws-ticket');
    await panel.getByRole('button', { name: 'Send' }).click();

    const outgoingRequest = await requestPromise;
    await expect(panel).toContainText('200 OK');
    await expect(panel).toContainText('"ticket"');

    return outgoingRequest.headers();
}

export async function enqueueControlCommand(
    request: APIRequestContext,
    runId: string,
    agentId: string,
    commandId: string,
    command: unknown,
): Promise<void> {
    const response = await request.post(
        `${FULL_STACK_CONTROL_BASE_URL}/runs/${encodeURIComponent(runId)}/agents/${
            encodeURIComponent(agentId)
        }/commands`,
        {
            data: {
                commandId,
                command,
            },
        },
    );
    expect(response.status()).toBe(202);
}

export async function fetchControlRun(
    request: APIRequestContext,
    runId: string,
): Promise<ControlRunSnapshot> {
    const response = await request.get(`${FULL_STACK_CONTROL_BASE_URL}/runs/${encodeURIComponent(runId)}`);
    expect(response.ok()).toBe(true);
    return await response.json() as ControlRunSnapshot;
}

export async function waitForControlCommandOk(
    request: APIRequestContext,
    runId: string,
    commandId: string,
): Promise<void> {
    await expect.poll(async () => {
        const run = await fetchControlRun(request, runId);
        return run.results?.some(result => result.commandId === commandId && result.ok === true) ?? false;
    }, {
        timeout: 30_000,
    }).toBe(true);
}

export function uniqueSuffix(): string {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function envValue(name: string): string | undefined {
    const value = process.env[name]?.trim();
    return value && value.length > 0 ? value : undefined;
}

function normalizeBaseUrl(value: string): string {
    return value.endsWith('/') ? value.slice(0, -1) : value;
}
