import { expect, type Page, test } from '@playwright/test';
import { installRecipeConsoleTuneFixture } from
    './recipe-console-tune-fixture.ts';
import { chooseTuneListboxOption, tuneListboxTrigger } from
    './recipe-console-tune-listbox-helpers.ts';
import {
    TUNE_COMPARE_ROUTE,
    TUNE_BASE_EPOCH_MS,
    TUNE_LEFT_CONTROL_RUN_ID,
    TUNE_LEFT_RUN_ID,
    TUNE_RIGHT_CONTROL_RUN_ID,
    TUNE_RIGHT_RUN_ID,
    TUNE_SHARED_AGENT_ID,
    TUNE_SLOW_AGENT_ID,
    TUNE_STREAM_COMMAND_ID,
    TUNE_STREAM_RECIPE_ID,
    TUNE_ROUTE,
} from './recipe-console-tune-run-data.ts';

const RECIPE_CONSOLE_VIEWS = [
    'execute',
    'monitor',
    'analyze',
    'tune',
    'fleet',
    'advanced',
] as const;

const SPA_ORIGIN = 'http://127.0.0.1:5176';
const RETENTION_PREVIEW_REQUEST = {
    kind: 'preview',
    method: 'POST',
    dryRun: true,
    hasPlanToken: false,
    body: null,
    authorization: null,
} as const;
const RETENTION_CONFIRM_REQUEST = {
    kind: 'confirm',
    method: 'POST',
    dryRun: false,
    hasPlanToken: true,
    body: null,
    authorization: null,
} as const;

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
            await expect(page.locator('[data-tune-workspace]')).toBeVisible();
            const candidateRun = tuneListboxTrigger(page, 'Candidate run');
            const candidateRunId = currentUrl(page).searchParams.get('compareRight');
            await expect(candidateRun).toBeVisible();
            await expect(candidateRun).toContainText(
                candidateRunId ?? 'Select candidate',
            );
            break;
        case 'fleet':
            await expect(page.locator('[data-fleet-operational-state="partial"]'))
                .toContainText('Fleet evidence is partial');
            await expect(page.locator('[data-preview-view="fleet"]'))
                .toContainText('Fleet report collection unavailable.');
            break;
        case 'advanced':
            await expect(page.locator('[data-preview-view="advanced"]'))
                .toContainText('Current diagnostic context');
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

test('commits all six views and restores them with browser back and forward', async ({ context, page }) => {
    await installRecipeConsoleTuneFixture(context);
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

test('restores versioned view selection filters comparison and timing metric from a copied URL', async ({ context, page }) => {
    await installRecipeConsoleTuneFixture(context);
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
        controlRunId: TUNE_RIGHT_CONTROL_RUN_ID,
        distributedRunId: TUNE_RIGHT_RUN_ID,
        agentId: TUNE_SHARED_AGENT_ID,
        recipeId: TUNE_STREAM_RECIPE_ID,
        commandId: TUNE_STREAM_COMMAND_ID,
        diagnosticSeverity: 'warning',
        transport: 'messages.rtc',
        historyQuery: 'candidate',
        historyGroup: 'tune-ci',
        historyRecipeId: TUNE_STREAM_RECIPE_ID,
        historyProfile: 'candidate',
        failureCategory: 'rtc-stream-performance',
        status: 'failed',
        from: String(TUNE_BASE_EPOCH_MS),
        to: String(TUNE_BASE_EPOCH_MS + 10_000),
        compareLeft: TUNE_LEFT_RUN_ID,
        compareRight: TUNE_RIGHT_RUN_ID,
        timingMetric: 'stream-cadence',
        fleetRegion: 'eu-north',
        fleetMapLayers: 'observed-routes,failures,live-agents',
    });
    await page.goto(`/?${fullState.toString()}`);

    await expectVisibleView(page, 'tune');
    await expect(page.locator('[data-tune-comparison]')).toContainText(
        TUNE_LEFT_RUN_ID,
    );
    await expect(page.locator('[data-tune-comparison]')).toContainText(
        TUNE_RIGHT_RUN_ID,
    );
    await expect(page.getByRole('button', { name: 'Cadence', exact: true }))
        .toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByLabel('Query', { exact: true })).toHaveValue('candidate');
    await expect(page.getByLabel('Group', { exact: true })).toHaveValue('tune-ci');
    await expect(page.getByLabel('Recipe', { exact: true }))
        .toHaveValue(TUNE_STREAM_RECIPE_ID);
    await expect(page.getByLabel('Profile', { exact: true })).toHaveValue('candidate');
    await expect(page.getByLabel('Failure category')).toHaveValue(
        'rtc-stream-performance',
    );
    await expect(page.getByLabel('Run status')).toHaveValue('failed');
    await expect(page.getByLabel('From (UTC)')).toHaveValue(
        utcInput(TUNE_BASE_EPOCH_MS),
    );
    await expect(page.getByLabel('To (UTC)')).toHaveValue(
        utcInput(TUNE_BASE_EPOCH_MS + 10_000),
    );
    const history = page.getByRole('region', { name: 'Recipe run history' });
    await expect(history).toContainText(TUNE_RIGHT_RUN_ID);
    await expect(history).not.toContainText(TUNE_LEFT_RUN_ID);
    await expect(page.locator('[data-history-workspace]')).toContainText(
        '1 filtered · 1 rendered · 0 omitted',
    );
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
    await expect(page.getByLabel('Failure category')).toHaveValue(
        'rtc-stream-performance',
    );
    await expect(history).toContainText(TUNE_RIGHT_RUN_ID);

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

function utcInput(epochMs: number): string {
    return new Date(epochMs).toISOString().slice(0, 19);
}

test('restores explicit Tune comparison and atomic focus through history', async ({
    context,
    page,
}) => {
    const fixture = await installRecipeConsoleTuneFixture(context);
    await context.grantPermissions(
        ['clipboard-read', 'clipboard-write'],
        { origin: SPA_ORIGIN },
    );
    await page.goto(`${TUNE_COMPARE_ROUTE}` +
        `&agentId=${TUNE_SHARED_AGENT_ID}` +
        `&recipeId=${TUNE_STREAM_RECIPE_ID}` +
        `&commandId=${TUNE_STREAM_COMMAND_ID}`);

    const comparison = page.locator('[data-tune-comparison]');
    await expect(comparison).toBeVisible();
    for (const category of [
        'recipe',
        'participant',
        'failure',
        'timing',
        'received-message',
        'performance',
    ]) {
        await expect(comparison.locator(`[data-compare-category="${category}"]`))
            .toBeVisible();
    }
    await page.reload();
    await expect(comparison).toContainText(TUNE_LEFT_RUN_ID);
    await expect(comparison).toContainText(TUNE_RIGHT_RUN_ID);

    const drift = page.getByRole('button', { name: 'Drift', exact: true });
    await drift.focus();
    await drift.press('Enter');
    await expect(drift).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/timingMetric=stream-drift/);
    await expect(comparison.locator('[data-compare-category="performance"]'))
        .toContainText('stream-drift');

    await page.getByRole('button', { name: 'Copy canonical link' }).click();
    const copiedHref = await readClipboardHref(page);
    const copied = new URL(copiedHref);
    expect(copied.searchParams.get('compareLeft')).toBe(TUNE_LEFT_RUN_ID);
    expect(copied.searchParams.get('compareRight')).toBe(TUNE_RIGHT_RUN_ID);
    expect(copied.searchParams.get('timingMetric')).toBe('stream-drift');
    await page.goto(copiedHref);
    await expect(drift).toHaveAttribute('aria-pressed', 'true');

    const rightAgent = page.locator('[data-tune-command-timing]')
        .locator('[data-tune-slow-agents="command"] button')
        .filter({ hasText: TUNE_SLOW_AGENT_ID });
    await rightAgent.focus();
    await rightAgent.press('Enter');
    const inspector = page.getByRole('complementary', { name: 'Inspector' });
    await expect(inspector.locator('[data-tune-inspector]'))
        .toContainText(TUNE_SLOW_AGENT_ID);
    const rightLegacyHref = new URL(
        await inspector.getByRole('link', {
            name: 'Open this run in legacy Runs',
        }).getAttribute('href') ?? '',
        page.url(),
    );
    expect(rightLegacyHref.searchParams.get('controlRunId'))
        .toBe(TUNE_RIGHT_CONTROL_RUN_ID);
    expect(rightLegacyHref.searchParams.get('distributedRunId'))
        .toBe(TUNE_RIGHT_RUN_ID);

    await chooseTuneListboxOption(page, 'Candidate run', TUNE_LEFT_RUN_ID);
    await expect(page.locator('[data-inspector-host]')).toHaveCount(0);
    await expect(page.getByText(`Agent · ${TUNE_SLOW_AGENT_ID}`, { exact: true }))
        .toHaveCount(0);
    await expect.poll(() => {
        const url = currentUrl(page);
        return {
            compareRight: url.searchParams.get('compareRight'),
            distributedRunId: url.searchParams.get('distributedRunId'),
            controlRunId: url.searchParams.get('controlRunId'),
            agentId: url.searchParams.get('agentId'),
            recipeId: url.searchParams.get('recipeId'),
            commandId: url.searchParams.get('commandId'),
        };
    }).toEqual({
        compareRight: TUNE_LEFT_RUN_ID,
        distributedRunId: TUNE_LEFT_RUN_ID,
        controlRunId: TUNE_LEFT_CONTROL_RUN_ID,
        agentId: null,
        recipeId: null,
        commandId: null,
    });
    await expect(comparison).toContainText(
        'Baseline and candidate must be different runs.',
    );

    await page.goBack();
    await expect.poll(() => ({
        compareRight: currentUrl(page).searchParams.get('compareRight'),
        distributedRunId: currentUrl(page).searchParams.get('distributedRunId'),
        controlRunId: currentUrl(page).searchParams.get('controlRunId'),
    })).toEqual({
        compareRight: TUNE_RIGHT_RUN_ID,
        distributedRunId: TUNE_RIGHT_RUN_ID,
        controlRunId: TUNE_RIGHT_CONTROL_RUN_ID,
    });
    await expect(comparison.locator('[data-compare-category="performance"]'))
        .toContainText('stream-drift');
    await page.goForward();
    await expect.poll(() => ({
        compareRight: currentUrl(page).searchParams.get('compareRight'),
        distributedRunId: currentUrl(page).searchParams.get('distributedRunId'),
        controlRunId: currentUrl(page).searchParams.get('controlRunId'),
    })).toEqual({
        compareRight: TUNE_LEFT_RUN_ID,
        distributedRunId: TUNE_LEFT_RUN_ID,
        controlRunId: TUNE_LEFT_CONTROL_RUN_ID,
    });
    expect(fixture.artifactRequestCount()).toBe(0);
    expect(fixture.mutationRequestCount()).toBe(0);
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
    const inspector = page.getByRole('dialog', { name: 'Inspector' });
    await inspector.getByRole('button', { name: 'Close inspector' }).click();
    await expect(inspector).toHaveCount(0);
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

test('previews retention impact before confirmed destructive cleanup', async ({
    context,
    page,
}) => {
    const fixture = await installRecipeConsoleTuneFixture(context, {
        retention: 'ready',
    });
    await context.grantPermissions(
        ['clipboard-read', 'clipboard-write'],
        { origin: SPA_ORIGIN },
    );
    const filterFrom = Date.UTC(2039, 0, 1);
    const filterTo = Date.UTC(2040, 0, 1);
    await page.goto(`${TUNE_COMPARE_ROUTE.replace(
        'timingMetric=stream-send-duration',
        'timingMetric=stream-drift',
    )}` +
        '&historyQuery=tune&historyGroup=tune-ci' +
        '&historyRecipeId=tune-rtc-stream&historyProfile=candidate' +
        '&failureCategory=rtc-stream-performance&status=failed' +
        `&from=${filterFrom}&to=${filterTo}`);

    await page.getByRole('button', { name: 'Preview cleanup' }).click();
    const retention = page.locator('[data-retention-panel]');
    await expect(retention).toContainText('2 current');
    await expect(retention).toContainText('1 projected');
    await expect(retention).toContainText('Cap 1');
    await expect(retention).toContainText(TUNE_RIGHT_CONTROL_RUN_ID);
    await retention.getByText('Linked distributed runs (1)', {
        exact: true,
    }).click();
    await expect(retention).toContainText(TUNE_RIGHT_RUN_ID);
    await expect(retention).toContainText(
        'Existing connected sockets and stored artifact files remain.',
    );
    expect(fixture.retentionRequests()).toEqual([RETENTION_PREVIEW_REQUEST]);
    expect(fixture.snapshotIds()).toEqual({
        controlRunIds: [TUNE_LEFT_CONTROL_RUN_ID, TUNE_RIGHT_CONTROL_RUN_ID],
        distributedRunIds: [TUNE_LEFT_RUN_ID, TUNE_RIGHT_RUN_ID],
    });
    expect(page.url()).not.toContain('history-plan-');
    expect(await page.locator('body').innerHTML()).not.toContain('history-plan-');

    await page.getByRole('button', {
        name: 'Review cleanup',
        exact: true,
    }).click();
    const dialog = page.getByRole('alertdialog', {
        name: 'Delete previewed runs?',
    });
    await expect(dialog.getByRole('button', { name: 'Keep history' }))
        .toBeFocused();
    const confirm = dialog.getByRole('button', {
        name: 'Delete previewed runs',
    });
    await page.keyboard.press('Tab');
    await expect(confirm).toBeFocused();
    await confirm.press('Enter');

    await expect(retention).toContainText('Cleanup completed');
    await expect(retention.getByRole('status')).toContainText(
        'Retention cleanup succeeded.',
    );
    const cleanupResult = retention.getByRole('heading', {
        name: 'Cleanup completed',
    }).locator('..');
    const deletedIds = cleanupResult.getByText(
        'Deleted control run IDs (1)',
        { exact: true },
    );
    await deletedIds.click();
    await expect(cleanupResult).toContainText(TUNE_RIGHT_CONTROL_RUN_ID);
    expect(fixture.retentionRequests()).toEqual([
        RETENTION_PREVIEW_REQUEST,
        RETENTION_CONFIRM_REQUEST,
    ]);
    await expect.poll(() => {
        const url = currentUrl(page);
        return {
            controlRunId: url.searchParams.get('controlRunId'),
            distributedRunId: url.searchParams.get('distributedRunId'),
            compareLeft: url.searchParams.get('compareLeft'),
            compareRight: url.searchParams.get('compareRight'),
            historyQuery: url.searchParams.get('historyQuery'),
            historyGroup: url.searchParams.get('historyGroup'),
            historyRecipeId: url.searchParams.get('historyRecipeId'),
            historyProfile: url.searchParams.get('historyProfile'),
            failureCategory: url.searchParams.get('failureCategory'),
            status: url.searchParams.get('status'),
            from: url.searchParams.get('from'),
            to: url.searchParams.get('to'),
            timingMetric: url.searchParams.get('timingMetric'),
        };
    }).toEqual({
        controlRunId: TUNE_LEFT_CONTROL_RUN_ID,
        distributedRunId: null,
        compareLeft: TUNE_LEFT_RUN_ID,
        compareRight: null,
        historyQuery: 'tune',
        historyGroup: 'tune-ci',
        historyRecipeId: 'tune-rtc-stream',
        historyProfile: 'candidate',
        failureCategory: 'rtc-stream-performance',
        status: 'failed',
        from: String(filterFrom),
        to: String(filterTo),
        timingMetric: 'stream-drift',
    });
    expect(page.url()).not.toContain('history-plan-');
    expect(await page.locator('body').innerHTML()).not.toContain('history-plan-');
    expect(await page.evaluate(() => JSON.stringify({
        local: Object.entries(localStorage),
        session: Object.entries(sessionStorage),
    }))).not.toContain('history-plan-');

    const copy = page.getByRole('button', { name: 'Copy filtered link' });
    await copy.focus();
    await copy.press('Enter');
    const copiedHref = await readClipboardHref(page);
    const copied = new URL(copiedHref);
    expect(historyFilterParams(copied)).toEqual({
        historyQuery: 'tune',
        historyGroup: 'tune-ci',
        historyRecipeId: 'tune-rtc-stream',
        historyProfile: 'candidate',
        failureCategory: 'rtc-stream-performance',
        status: 'failed',
        from: String(filterFrom),
        to: String(filterTo),
    });
    expect(copiedHref).not.toContain('history-plan-');

    await page.getByRole('button', { name: 'Reset', exact: true }).click();
    await expect.poll(() => historyFilterParams(currentUrl(page))).toEqual(
        EMPTY_HISTORY_FILTER_PARAMS,
    );
    await page.goBack();
    await expect.poll(() => historyFilterParams(currentUrl(page))).toEqual(
        historyFilterParams(copied),
    );
    await page.goForward();
    await expect.poll(() => historyFilterParams(currentUrl(page))).toEqual(
        EMPTY_HISTORY_FILTER_PARAMS,
    );
    const order = fixture.requestOrder();
    const confirmIndex = order.lastIndexOf('confirm');
    expect(confirmIndex).toBeGreaterThan(-1);
    expect(order.slice(confirmIndex + 1)).toEqual(
        expect.arrayContaining(['runs', 'distributed-runs']),
    );
    expect(fixture.snapshotIds()).toEqual({
        controlRunIds: [TUNE_LEFT_CONTROL_RUN_ID],
        distributedRunIds: [TUNE_LEFT_RUN_ID],
    });
    await expect(page.getByRole('region', { name: 'Recipe run history' }))
        .not.toContainText(TUNE_RIGHT_RUN_ID);
});

test('cancels cleanup without issuing a destructive request', async ({
    context,
    page,
}) => {
    const fixture = await installRecipeConsoleTuneFixture(context, {
        retention: 'ready',
    });
    await page.goto(TUNE_ROUTE);
    const preview = page.getByRole('button', {
        name: 'Preview cleanup',
        exact: true,
    });
    await preview.focus();
    await preview.press('Enter');
    const review = page.getByRole('button', {
        name: 'Review cleanup',
        exact: true,
    });
    await review.focus();
    await review.press('Enter');

    const dialog = page.getByRole('alertdialog', {
        name: 'Delete previewed runs?',
    });
    await expect(dialog.getByRole('button', { name: 'Keep history' }))
        .toBeFocused();
    await page.keyboard.press('Escape');

    await expect(dialog).toHaveCount(0);
    await expect(preview).toBeFocused();
    expect(fixture.retentionRequests()).toEqual([RETENTION_PREVIEW_REQUEST]);
    expect(fixture.snapshotIds().distributedRunIds).toEqual([
        TUNE_LEFT_RUN_ID,
        TUNE_RIGHT_RUN_ID,
    ]);
});

test('requires a fresh preview after retention drift', async ({
    context,
    page,
}) => {
    const fixture = await installRecipeConsoleTuneFixture(context, {
        retention: 'drift-once',
    });
    await page.goto(TUNE_ROUTE);
    const preview = page.getByRole('button', {
        name: 'Preview cleanup',
        exact: true,
    });
    await preview.click();
    await page.getByRole('button', {
        name: 'Review cleanup',
        exact: true,
    }).click();
    await page.getByRole('button', { name: 'Delete previewed runs' }).click();

    const retention = page.locator('[data-retention-panel]');
    await expect(retention).toContainText('Retention preview drifted.');
    await expect(retention).toContainText('Stale preview · not current');
    await expect(page.getByRole('button', {
        name: 'Review cleanup',
        exact: true,
    })).toHaveCount(0);
    expect(fixture.snapshotIds().distributedRunIds).toEqual([
        TUNE_LEFT_RUN_ID,
        TUNE_RIGHT_RUN_ID,
    ]);
    expect(fixture.retentionRequests().map(request => request.kind)).toEqual([
        'preview',
        'confirm',
    ]);

    await preview.click();
    await expect(page.getByRole('button', {
        name: 'Review cleanup',
        exact: true,
    })).toBeVisible();
    expect(fixture.retentionRequests().map(request => request.kind)).toEqual([
        'preview',
        'confirm',
        'preview',
    ]);
});

test('shows retention authorization failure without consequence disclosure', async ({
    context,
    page,
}) => {
    const fixture = await installRecipeConsoleTuneFixture(context, {
        retention: 'authorization-required',
    });
    await page.goto(TUNE_ROUTE);
    await page.getByRole('button', {
        name: 'Preview cleanup',
        exact: true,
    }).click();

    const retention = page.locator('[data-retention-panel]');
    await expect(retention.getByRole('status')).toContainText(
        'Operator authorization required.',
    );
    await expect(retention).not.toContainText(TUNE_RIGHT_CONTROL_RUN_ID);
    await expect(retention).not.toContainText(TUNE_RIGHT_RUN_ID);
    await expect(page.getByRole('button', {
        name: 'Review cleanup',
        exact: true,
    })).toHaveCount(0);
    expect(fixture.retentionRequests()).toEqual([RETENTION_PREVIEW_REQUEST]);
    expect(fixture.snapshotIds().distributedRunIds).toEqual([
        TUNE_LEFT_RUN_ID,
        TUNE_RIGHT_RUN_ID,
    ]);
});

test('finds a past failure, compares it, and manages saved filters', async ({
    context,
    page,
}) => {
    const fixture = await installRecipeConsoleTuneFixture(context);
    await context.grantPermissions(
        ['clipboard-read', 'clipboard-write'],
        { origin: SPA_ORIGIN },
    );
    await page.goto(TUNE_ROUTE);

    const history = page.getByRole('region', { name: 'Recipe run history' });
    await expect(history.locator('tbody tr')).toHaveCount(2);
    const baseline = page.getByRole('button', {
        name: `Set ${TUNE_LEFT_RUN_ID} as comparison baseline`,
    });
    await baseline.focus();
    await baseline.press('Enter');
    const candidate = page.getByRole('button', {
        name: `Set ${TUNE_RIGHT_RUN_ID} as comparison candidate`,
    });
    await candidate.focus();
    await candidate.press('Enter');
    await expect(page.locator('[data-tune-comparison]'))
        .toContainText(TUNE_LEFT_RUN_ID);
    await expect(page.locator('[data-tune-comparison]'))
        .toContainText(TUNE_RIGHT_RUN_ID);

    const query = page.getByLabel('Query', { exact: true });
    const group = page.getByLabel('Group', { exact: true });
    const recipe = page.getByLabel('Recipe', { exact: true });
    const profile = page.getByLabel('Profile', { exact: true });
    const failureCategory = page.getByLabel('Failure category');
    const status = page.getByLabel('Run status');
    const from = page.getByLabel('From (UTC)');
    const to = page.getByLabel('To (UTC)');
    const apply = page.getByRole('button', { name: 'Apply filters' });
    const reset = page.getByRole('button', { name: 'Reset', exact: true });
    await query.focus();
    await query.pressSequentially('candidate');
    await page.keyboard.press('Tab');
    await expect(group).toBeFocused();
    await group.pressSequentially('tune-ci');
    await page.keyboard.press('Tab');
    await expect(recipe).toBeFocused();
    await recipe.pressSequentially(TUNE_STREAM_RECIPE_ID);
    await page.keyboard.press('Tab');
    await expect(profile).toBeFocused();
    await profile.pressSequentially('candidate');
    await page.keyboard.press('Tab');
    await expect(failureCategory).toBeFocused();
    await failureCategory.pressSequentially('rtc');
    await expect(failureCategory).toHaveValue('rtc-stream-performance');
    await page.keyboard.press('Tab');
    await expect(status).toBeFocused();
    await status.press('f');
    await expect(status).toHaveValue('failed');
    await page.keyboard.press('Tab');
    await expect(from).toBeFocused();
    await keyboardDateTimeUntil(page, from, to, 2039);
    await keyboardDateTimeUntil(page, to, reset, 2040);
    const selectedFrom = await from.inputValue();
    const selectedTo = await to.inputValue();
    expect(selectedFrom).toMatch(/^2039-/u);
    expect(selectedTo).toMatch(/^2040-/u);
    await page.keyboard.press('Tab');
    await expect(apply).toBeFocused();
    await apply.press('Enter');

    await expect(history.locator('tbody tr')).toHaveCount(1);
    await expect(history).toContainText(TUNE_RIGHT_RUN_ID);
    await expect(history).toContainText('RTC stream exceeded pacing');
    await expect(page.locator('[data-history-workspace]')).toContainText(
        '1 filtered · 1 rendered · 0 omitted',
    );

    const presetName = page.getByLabel('Preset name');
    await keyboardFill(presetName, 'Failed RTC candidate');
    const save = page.getByRole('button', { name: 'Save current filters' });
    await save.focus();
    await save.press('Enter');
    await expect(page.getByRole('button', {
        name: 'Apply Failed RTC candidate',
    })).toBeVisible();

    const copy = page.getByRole('button', { name: 'Copy filtered link' });
    await copy.focus();
    await copy.press('Enter');
    const copied = new URL(await readClipboardHref(page));
    const savedFilterParams = {
        historyQuery: 'candidate',
        historyGroup: 'tune-ci',
        historyRecipeId: TUNE_STREAM_RECIPE_ID,
        historyProfile: 'candidate',
        failureCategory: 'rtc-stream-performance',
        status: 'failed',
        from: historyControlEpoch(selectedFrom),
        to: historyControlEpoch(selectedTo),
    };
    expect(historyFilterParams(copied)).toEqual(savedFilterParams);

    await reset.focus();
    await reset.press('Enter');
    await expect(history.locator('tbody tr')).toHaveCount(2);
    await expect.poll(() => historyFilterParams(currentUrl(page))).toEqual(
        EMPTY_HISTORY_FILTER_PARAMS,
    );

    const applyPreset = page.getByRole('button', {
        name: 'Apply Failed RTC candidate',
    });
    await applyPreset.focus();
    await applyPreset.press('Enter');
    await expect(history.locator('tbody tr')).toHaveCount(1);
    await expect.poll(() => historyFilterParams(currentUrl(page)))
        .toEqual(savedFilterParams);
    await expectHistoryFilterControls(page, savedFilterParams);
    await page.goBack();
    await expect(history.locator('tbody tr')).toHaveCount(2);
    await expect.poll(() => historyFilterParams(currentUrl(page))).toEqual(
        EMPTY_HISTORY_FILTER_PARAMS,
    );
    await expectHistoryFilterControls(page, EMPTY_HISTORY_FILTER_PARAMS);
    await page.goForward();
    await expect(history.locator('tbody tr')).toHaveCount(1);
    await expect.poll(() => historyFilterParams(currentUrl(page)))
        .toEqual(savedFilterParams);
    await expectHistoryFilterControls(page, savedFilterParams);

    const deletePreset = page.getByRole('button', {
        name: 'Delete Failed RTC candidate',
    });
    await deletePreset.focus();
    await deletePreset.press('Enter');
    await expect(page.getByText('No saved filters yet.', { exact: true }))
        .toBeVisible();
    expect(fixture.retentionRequests()).toEqual([]);
});

async function keyboardFill(
    locator: ReturnType<Page['locator']>,
    value: string,
): Promise<void> {
    await locator.focus();
    await locator.press('ControlOrMeta+A');
    await locator.pressSequentially(value);
}

const EMPTY_HISTORY_FILTER_PARAMS = {
    historyQuery: null,
    historyGroup: null,
    historyRecipeId: null,
    historyProfile: null,
    failureCategory: null,
    status: null,
    from: null,
    to: null,
} as const;

function historyFilterParams(url: URL) {
    return {
        historyQuery: url.searchParams.get('historyQuery'),
        historyGroup: url.searchParams.get('historyGroup'),
        historyRecipeId: url.searchParams.get('historyRecipeId'),
        historyProfile: url.searchParams.get('historyProfile'),
        failureCategory: url.searchParams.get('failureCategory'),
        status: url.searchParams.get('status'),
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
    };
}

async function keyboardDateTimeUntil(
    page: Page,
    locator: ReturnType<Page['locator']>,
    next: ReturnType<Page['locator']>,
    year: number,
): Promise<void> {
    await expect(locator).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Tab');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Tab');
    await page.keyboard.type(String(year));
    for (let step = 0; step < 8; step += 1) {
        await page.keyboard.press('Tab');
        if (await next.evaluate(element => document.activeElement === element)) {
            return;
        }
        await page.keyboard.press('ArrowUp');
    }
    throw new Error(`Keyboard traversal did not reach the control after ${year}`);
}

async function expectHistoryFilterControls(
    page: Page,
    expected: ReturnType<typeof historyFilterParams>,
): Promise<void> {
    const values = {
        historyQuery: await page.getByLabel('Query', { exact: true }).inputValue(),
        historyGroup: await page.getByLabel('Group', { exact: true }).inputValue(),
        historyRecipeId: await page.getByLabel('Recipe', { exact: true })
            .inputValue(),
        historyProfile: await page.getByLabel('Profile', { exact: true })
            .inputValue(),
        failureCategory: await page.getByLabel('Failure category').inputValue(),
        status: await page.getByLabel('Run status').inputValue(),
        from: historyControlEpoch(await page.getByLabel('From (UTC)').inputValue()),
        to: historyControlEpoch(await page.getByLabel('To (UTC)').inputValue()),
    };
    expect(values).toEqual(Object.fromEntries(Object.entries(expected).map(
        ([key, value]) => [key, value ?? ''],
    )));
}

function historyControlEpoch(value: string): string {
    return value === '' ? '' : String(Date.parse(`${value}Z`));
}
