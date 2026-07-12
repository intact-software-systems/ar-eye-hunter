import { expect, type Page, test } from '@playwright/test';

const RECIPE_CONSOLE_VIEWS = [
    'execute',
    'monitor',
    'analyze',
    'tune',
    'fleet',
    'advanced',
] as const;

const SPA_ORIGIN = 'http://127.0.0.1:5176';

type RecipeConsoleView = typeof RECIPE_CONSOLE_VIEWS[number];

const VIEW_LABELS: Readonly<Record<RecipeConsoleView, string>> = {
    execute: 'Execute',
    monitor: 'Monitor',
    analyze: 'Analyze',
    tune: 'Tune',
    fleet: 'Fleet',
    advanced: 'Advanced',
};

async function expectVisibleView(page: Page, view: RecipeConsoleView): Promise<void> {
    await expect(page.locator('.recipe-console')).toHaveAttribute('data-view', view);
    await expect(page.getByRole('heading', { level: 1, name: VIEW_LABELS[view] }))
        .toBeVisible();

    switch (view) {
        case 'execute':
            await expect(page.getByRole('searchbox', { name: 'Search recipes' }))
                .toBeVisible();
            break;
        case 'monitor':
            await expect(page.locator('[data-monitor-workspace]')).toBeVisible();
            break;
        case 'analyze':
            await expect(page.locator('[data-analyze-workspace]')).toBeVisible();
            await expect(page.locator('[data-analyze-source]')).toBeVisible();
            await expect(page.getByText('Choose files', { exact: true })).toBeVisible();
            await expect(page.getByRole('heading', {
                name: 'Import distributed-run evidence',
            })).toBeVisible();
            await expect(page.locator('[data-inspector-host]')).toHaveCount(0);
            break;
        case 'tune':
            await expect(page.locator('[data-preview-view="tune"]'))
                .toContainText('Command-duration only');
            break;
        case 'fleet':
            await expect(page.locator('[data-preview-view="fleet"]'))
                .toContainText('Fleet live data unavailable in offline preview');
            break;
        case 'advanced':
            await expect(page.locator('[data-preview-view="advanced"]'))
                .toContainText('Legacy compatibility bridge');
            break;
    }
}

function currentUrl(page: Page): URL {
    return new URL(page.url());
}

function expectSafeUnknownState(page: Page): void {
    const url = currentUrl(page);
    expect(url.searchParams.get('provider')).toBe('simulated');
    expect(url.searchParams.get('roomId')).toBe('room-safe');
    expect(url.searchParams.get('futureField')).toBe('keep');
    expect(url.searchParams.get('v')).toBe('1');
    expect(url.searchParams.get('experience')).toBe('recipe-console');
}

async function readClipboardHref(page: Page): Promise<string> {
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toContain('experience=recipe-console');
    return page.evaluate(() => navigator.clipboard.readText());
}

test('commits all six views and restores them with browser back and forward', async ({ page }) => {
    const initial = new URLSearchParams({
        provider: 'simulated',
        roomId: 'room-safe',
        futureField: 'keep',
        v: '1',
        experience: 'recipe-console',
        view: 'execute',
    });
    await page.goto(`/?${initial.toString()}`);
    const initialHistoryLength = await page.evaluate(() => history.length);

    await expectVisibleView(page, 'execute');
    expectSafeUnknownState(page);
    for (const view of RECIPE_CONSOLE_VIEWS.slice(1)) {
        await page.getByRole('button', { name: VIEW_LABELS[view], exact: true }).click();
        await expectVisibleView(page, view);
        expect(currentUrl(page).searchParams.get('view')).toBe(view);
        expectSafeUnknownState(page);
    }
    expect(await page.evaluate(() => history.length)).toBe(initialHistoryLength + 5);

    for (const view of [...RECIPE_CONSOLE_VIEWS].reverse().slice(1)) {
        await page.goBack();
        await expectVisibleView(page, view);
        expect(currentUrl(page).searchParams.get('view')).toBe(view);
        expectSafeUnknownState(page);
    }

    for (const view of RECIPE_CONSOLE_VIEWS.slice(1)) {
        await page.goForward();
        await expectVisibleView(page, view);
        expect(currentUrl(page).searchParams.get('view')).toBe(view);
        expectSafeUnknownState(page);
    }
});

test('restores the required Execute details inspector through browser history', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/?provider=simulated&v=1&experience=recipe-console&view=execute');
    await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
    await expect(page.getByText('Recipe details', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Analyze', exact: true }).click();
    await expectVisibleView(page, 'analyze');
    await expect(page.locator('[data-inspector-host]')).toHaveCount(0);

    await page.goBack();
    await expectVisibleView(page, 'execute');
    await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
    await expect(page.getByText('Recipe details', { exact: true })).toBeVisible();
});

test('restores a complete copied v1 state without inventing reserved-field UI', async ({ context, page }) => {
    await context.grantPermissions(
        ['clipboard-read', 'clipboard-write'],
        { origin: SPA_ORIGIN },
    );
    const fullState = new URLSearchParams({
        provider: 'simulated',
        futureField: 'future',
        v: '1',
        experience: 'recipe-console',
        view: 'tune',
        controlRunId: 'control-a',
        distributedRunId: 'distributed-a',
        agentId: 'agent-a',
        recipeId: 'recipe-a',
        commandId: 'command-a',
        diagnosticSeverity: 'warning',
        transport: 'messages.rtc',
        historyQuery: 'failed ack',
        status: 'waiting-for-barrier',
        from: '100',
        to: '900',
        compareLeft: 'baseline-a',
        compareRight: 'candidate-a',
        timingMetric: 'stream-cadence',
        fleetRegion: 'eu-north',
        fleetMapLayers: 'observed-routes,failures,live-agents',
    });
    await page.goto(`/?${fullState.toString()}`);

    await expectVisibleView(page, 'tune');
    await expect(page.getByRole('button', { name: 'Cadence', exact: true }))
        .toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Copy canonical link' }).click();
    const copiedHref = await readClipboardHref(page);
    const copied = new URL(copiedHref);
    for (const [key, value] of fullState) {
        expect(copied.searchParams.get(key), key).toBe(
            key === 'fleetMapLayers'
                ? 'live-agents,failures,observed-routes'
                : value,
        );
    }
    expect(copied.origin).toBe(SPA_ORIGIN);
    expect(copied.hash).toBe('');

    await page.goto(copiedHref);
    await expectVisibleView(page, 'tune');
    await expect(page.getByRole('button', { name: 'Cadence', exact: true }))
        .toHaveAttribute('aria-pressed', 'true');

    const advancedHref = new URL(copiedHref);
    advancedHref.searchParams.set('view', 'advanced');
    advancedHref.searchParams.set('legacySurface', 'rtc-diagnostics');
    await page.evaluate((href) => {
        history.pushState({}, '', href);
        dispatchEvent(new PopStateEvent('popstate'));
    }, advancedHref.toString());
    await expectVisibleView(page, 'advanced');
    expect(currentUrl(page).searchParams.get('legacySurface')).toBe('rtc-diagnostics');

    await page.getByRole('button', { name: 'Tune', exact: true }).click();
    await expectVisibleView(page, 'tune');
    expect(currentUrl(page).searchParams.has('legacySurface')).toBe(false);
    await page.goBack();
    await expectVisibleView(page, 'advanced');
    expect(currentUrl(page).searchParams.get('legacySurface')).toBe('rtc-diagnostics');
});

test('scrubs sensitive state from copied and committed URLs while harmless fields survive', async ({ context, page }) => {
    await context.grantPermissions(
        ['clipboard-read', 'clipboard-write'],
        { origin: SPA_ORIGIN },
    );
    const query = new URLSearchParams({
        provider: 'simulated',
        roomId: 'room-safe',
        futureField: 'keep',
        v: '1',
        experience: 'recipe-console',
        view: 'execute',
        controlRunId: 'control-safe',
        token: 'query-secret',
        PaSsWoRd: 'query-password',
        agentSessionTicket: 'query-ticket',
    });
    await page.goto(
        `/?${query.toString()}#agentSessionTicket=fragment-ticket&trace=keep&PaSsWoRd=fragment-password&pane=evidence`,
    );

    await expectVisibleView(page, 'execute');
    const sensitiveKeys = new Set([
        'agentsessionticket',
        'controltoken',
        'rallarpassword',
        'rallartoken',
        'accesstoken',
        'refreshtoken',
        'password',
        'token',
    ]);
    await expect.poll(() => {
        const url = currentUrl(page);
        return {
            hash: url.hash,
            sensitive: [...url.searchParams.keys()]
                .filter(key => sensitiveKeys.has(key.toLowerCase())),
            version: url.searchParams.get('v'),
        };
    }).toEqual({
        hash: '#trace=keep&pane=evidence',
        sensitive: [],
        version: '1',
    });
    await page.getByRole('button', { name: 'Copy canonical link' }).click();
    const copied = new URL(await readClipboardHref(page));
    expect(
        [...copied.searchParams.keys()]
            .filter(key => sensitiveKeys.has(key.toLowerCase())),
    ).toEqual([]);
    expect(copied.hash).toBe('#trace=keep&pane=evidence');

    await page.getByRole('button', { name: 'Monitor', exact: true }).click();
    await expectVisibleView(page, 'monitor');

    const url = currentUrl(page);
    expect(url.searchParams.get('provider')).toBe('simulated');
    expect(url.searchParams.get('roomId')).toBe('room-safe');
    expect(url.searchParams.get('futureField')).toBe('keep');
    expect(url.searchParams.get('controlRunId')).toBe('control-safe');
    expect(url.searchParams.get('view')).toBe('monitor');
    expect(
        [...url.searchParams.keys()].filter(key => sensitiveKeys.has(key.toLowerCase())),
    ).toEqual([]);
    expect(url.hash).toBe('#trace=keep&pane=evidence');
    expect(url.href).not.toContain('query-secret');
    expect(url.href).not.toContain('query-password');
    expect(url.href).not.toContain('query-ticket');
    expect(url.href).not.toContain('fragment-ticket');
    expect(url.href).not.toContain('fragment-password');
});

test('shows the exact visible fallback for an invalid view', async ({ context, page }) => {
    await context.grantPermissions(
        ['clipboard-read', 'clipboard-write'],
        { origin: SPA_ORIGIN },
    );
    await page.setViewportSize({ width: 430, height: 932 });
    await page.goto(
        '/?provider=simulated&roomId=room-safe&v=1&experience=recipe-console' +
        '&view=not-a-view&controlRunId=control-safe',
    );

    await expectVisibleView(page, 'execute');
    await expect(page.getByText(
        'view is not a supported Recipe Console view.',
        { exact: true },
    )).toBeVisible();
    const issueBounds = await page.locator('[data-url-issues]').boundingBox();
    const headingBounds = await page.getByRole('heading', {
        level: 1,
        name: 'Execute recipe',
    }).boundingBox();
    expect(issueBounds).not.toBeNull();
    expect(headingBounds).not.toBeNull();
    expect((issueBounds?.y ?? 0) + (issueBounds?.height ?? 0))
        .toBeLessThanOrEqual(headingBounds?.y ?? 0);
    await expect.poll(() => currentUrl(page).searchParams.get('view'))
        .toBe('execute');
    await page.getByRole('button', { name: 'Copy canonical link' }).click();
    const copied = new URL(await readClipboardHref(page));
    expect(copied.searchParams.get('view')).toBe('execute');
    expect(copied.searchParams.get('controlRunId')).toBe('control-safe');
    expect(copied.searchParams.get('roomId')).toBe('room-safe');
});

test('canonicalizes initial and popstate URLs with replaceState', async ({ page }) => {
    await page.addInitScript(() => {
        const calls: string[] = [];
        const replaceState = history.replaceState.bind(history);
        history.replaceState = (data: unknown, unused: string, url?: string | URL | null): void => {
            calls.push(String(url ?? ''));
            replaceState(data, unused, url);
        };
        Object.defineProperty(window, '__recipeConsoleReplaceCalls', {
            value: calls,
        });
    });

    await page.goto('/?provider=simulated&futureField=keep&experience=recipe-console&view=execute');
    await expectVisibleView(page, 'execute');
    const initialLength = await page.evaluate(() => history.length);
    await expect.poll(() => currentUrl(page).searchParams.get('v')).toBe('1');
    await expect.poll(() => page.evaluate(() =>
        (window as Window & { __recipeConsoleReplaceCalls: string[] })
            .__recipeConsoleReplaceCalls.length
    )).toBe(1);
    await expect.poll(() => currentUrl(page).searchParams.get('recipeId'))
        .toBe('rtc-realtime-stability');

    await page.evaluate(() => {
        history.pushState(
            {},
            '',
            '/?provider=simulated&futureField=keep&experience=recipe-console&view=invalid',
        );
        dispatchEvent(new PopStateEvent('popstate'));
    });
    await expectVisibleView(page, 'execute');
    await expect(page.getByText(
        'view is not a supported Recipe Console view.',
        { exact: true },
    )).toBeVisible();
    await expect.poll(() => currentUrl(page).searchParams.get('view')).toBe('execute');
    await expect.poll(() => page.evaluate(() =>
        (window as Window & { __recipeConsoleReplaceCalls: string[] })
            .__recipeConsoleReplaceCalls.length
    )).toBe(3);
    expect(await page.evaluate(() => history.length)).toBe(initialLength + 1);
    expect(currentUrl(page).searchParams.get('futureField')).toBe('keep');
});

test('mounts the legacy 250ms clock only for the active legacy experience', async ({ page }) => {
    await page.addInitScript(() => {
        const active = new Map<number, number>();
        const nativeSetInterval = window.setInterval.bind(window);
        const nativeClearInterval = window.clearInterval.bind(window);

        Object.defineProperty(window, 'setInterval', {
            configurable: true,
            value: (handler: TimerHandler, timeout?: number, ...args: unknown[]): number => {
                const id = nativeSetInterval(handler, timeout, ...args);
                active.set(id, timeout ?? 0);
                return id;
            },
            writable: true,
        });
        Object.defineProperty(window, 'clearInterval', {
            configurable: true,
            value: (id?: number): void => {
                if (id !== undefined) {
                    active.delete(id);
                    nativeClearInterval(id);
                }
            },
            writable: true,
        });
        Object.defineProperty(window, '__recipeConsoleIntervalProbe', {
            value: {
                active250: (): number =>
                    [...active.values()].filter(timeout => timeout === 250).length,
            },
        });
    });

    const active250 = (): Promise<number> => page.evaluate(() =>
        (window as Window & {
            __recipeConsoleIntervalProbe: { active250(): number };
        }).__recipeConsoleIntervalProbe.active250()
    );

    await page.goto('/?provider=simulated&v=1&experience=recipe-console&view=execute');
    await expect(page.locator('.recipe-console')).toBeVisible();
    await expect.poll(active250).toBe(0);

    await page.goto('/?provider=simulated&experience=legacy&workspace=black-box-runner&tab=recipes');
    await expect(page.locator('.app-shell')).toBeVisible();
    await expect.poll(active250).toBeGreaterThanOrEqual(1);

    await page.evaluate(() => {
        history.pushState(
            {},
            '',
            '/?provider=simulated&v=1&experience=recipe-console&view=monitor',
        );
        dispatchEvent(new PopStateEvent('popstate'));
    });
    await expectVisibleView(page, 'monitor');
    await expect(page.locator('.app-shell')).toHaveCount(0);
    await expect.poll(active250).toBe(0);
});

test('preserves runner-agent launch ticket semantics in legacy', async ({ context, page }) => {
    const apiBaseUrl = 'https://api.recipe-console-ticket.test';
    const query = new URLSearchParams({
        mode: 'control',
        workspace: 'black-box-runner',
        tab: 'local-workbench',
        provider: 'browser-rallar',
        apiBaseUrl,
        rallarAuthStorage: 'session',
        rallarRestoreSession: '1',
        autoConnect: '0',
    });
    const consumedTickets: string[] = [];

    await context.route(`${apiBaseUrl}/**`, async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() === 'POST' &&
            url.pathname === '/api/auth/agent-session-tickets/consume') {
            const body = await request.postDataJSON() as { ticket?: string };
            consumedTickets.push(body.ticket ?? '');
            await new Promise(resolve => setTimeout(resolve, 100));
            await route.fulfill({
                contentType: 'application/json',
                json: {
                    clientId: 'runner-agent',
                    accessToken: 'runner-agent-access-token',
                    username: 'runner-agent',
                    sessionId: 'runner-agent-session',
                    expiresAtEpochMs: Date.now() + 60_000,
                },
            });
            return;
        }
        if (url.pathname === '/api/config') {
            await route.fulfill({
                contentType: 'application/json',
                json: {
                    apiBaseUrl,
                    wsBaseUrl: 'wss://api.recipe-console-ticket.test',
                    endpoints: { createWs: `${apiBaseUrl}/api/ws` },
                },
            });
            return;
        }
        await route.fulfill({
            contentType: 'application/json',
            status: 404,
            json: { error: `Unhandled ${request.method()} ${url.pathname}` },
        });
    });

    await page.goto(
        `/?${query.toString()}#agentSessionTicket=runner-ticket&trace=keep`,
    );

    await expect.poll(() => consumedTickets).toEqual(['runner-ticket']);
    await expect(page.locator('.app-shell')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Advanced', exact: true }))
        .toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#panel-local-workbench')).toBeVisible();
    await expect(page.locator('#panel-local-workbench')
        .getByRole('heading', { name: 'Local Workbench', exact: true }))
        .toBeVisible();

    const finalUrl = currentUrl(page);
    expect(finalUrl.searchParams.toString()).toBe(query.toString());
    expect(finalUrl.hash).toBe('#trace=keep');
    expect(consumedTickets).toEqual(['runner-ticket']);
});
