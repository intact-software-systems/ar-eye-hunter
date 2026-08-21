import {
    expect,
    test,
    type BrowserContext,
    type Route,
} from '@playwright/test';

const CONTROL_ROUTE = /https?:\/\/(?:localhost|127\.0\.0\.1):5180\/.*/;
const API_ROUTE = /https?:\/\/(?:localhost|127\.0\.0\.1):8080\/.*/;
const STORAGE_KEY = 'rallar.black-box.recipe-console.preferences.v1';
const RECIPE_CONSOLE_ROUTE =
    '/?provider=simulated&v=1&experience=recipe-console&view=execute';

test('saves, restores, resets, and closes personal defaults from the command bar', async ({
    context,
    page,
}) => {
    await installControlMock(context);
    await page.goto(RECIPE_CONSOLE_ROUTE);

    const trigger = page.getByRole('button', {
        name: 'Open account and settings',
    });
    await trigger.click();
    const panel = page.getByRole('dialog', { name: 'Account and settings' });
    await expect(panel).toBeVisible();
    const apiUrlInput = panel.getByLabel('API URL');
    await expect(apiUrlInput).toBeDisabled();
    await expect(
        apiUrlInput.locator('..').getByText('Managed by deployment', { exact: true }),
    ).toBeVisible();

    await panel.getByLabel('Application').fill('personal-operator-app');
    await panel.getByLabel('Control read timeout (ms)').fill('30000');
    await panel.getByRole('button', { name: 'Save defaults' }).click();
    await expect(panel.getByRole('status')).toContainText('Defaults saved.');

    const stored = await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY);
    expect(JSON.parse(stored ?? '{}')).toEqual({
        version: 1,
        values: {
            controlUrl: 'ws://localhost:5180/control',
            applicationId: 'personal-operator-app',
            workspaceId: 'default',
            groupId: 'rallar-black-box-room',
            controlReadTimeoutMs: 30_000,
        },
    });

    await page.reload();
    await page.getByRole('button', { name: 'Open account and settings' }).click();
    const restored = page.getByRole('dialog', { name: 'Account and settings' });
    await expect(restored.getByLabel('Application'))
        .toHaveValue('personal-operator-app');
    await expect(restored.getByLabel('Control read timeout (ms)'))
        .toHaveValue('30000');

    await restored.getByRole('button', { name: 'Reset defaults' }).click();
    await expect.poll(
        async () => await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY),
    ).toBeNull();
    await expect(restored.getByLabel('Application')).toHaveValue('rallar-black-box');
    await expect(restored.getByLabel('Control read timeout (ms)')).toHaveValue('20000');

    await page.keyboard.press('Escape');
    await expect(restored).toBeHidden();
    await expect(page.getByRole('button', {
        name: 'Open account and settings',
    })).toBeFocused();
});

test('logs an authenticated operator out through the visible account control', async ({
    context,
    page,
}) => {
    await installControlMock(context);
    await context.addInitScript(session => {
        localStorage.setItem('auth.session', JSON.stringify(session));
    }, {
        clientId: 'operator-client',
        accessToken: 'operator-access',
        username: 'operator@example.test',
        sessionId: 'operator-session',
        expiresAtEpochMs: Date.now() + 60_000,
    });
    await context.route(API_ROUTE, async route => {
        const url = new URL(route.request().url());
        if (url.pathname.startsWith('/api/auth/logout/requests/')) {
            await fulfillJson(route, 200, { loggedOut: true });
            return;
        }
        await fulfillJson(route, 404, { error: 'Unhandled API request.' });
    });

    await page.goto(
        '/?provider=browser-rallar&v=1&experience=recipe-console&view=execute',
    );
    await page.getByRole('button', { name: 'Open account and settings' }).click();
    const panel = page.getByRole('dialog', { name: 'Account and settings' });
    await expect(panel.getByText('operator@example.test', { exact: true }))
        .toBeVisible();
    await expect(panel.getByText('Session active', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Logout' }).click();

    await expect(page.getByRole('heading', { name: 'Rallar Server Login' }))
        .toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('auth.session')))
        .toBeNull();
});

async function installControlMock(context: BrowserContext): Promise<void> {
    await context.route(CONTROL_ROUTE, async route => {
        const url = new URL(route.request().url());
        if (route.request().method() === 'GET' && url.pathname === '/runs') {
            await fulfillJson(route, 200, { runs: [], distributedRuns: [] });
            return;
        }
        await fulfillJson(route, 404, {
            error: `Unhandled ${route.request().method()} ${url.pathname}`,
        });
    });
}

async function fulfillJson(
    route: Route,
    status: number,
    body: unknown,
): Promise<void> {
    await route.fulfill({
        status,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(body),
    });
}
