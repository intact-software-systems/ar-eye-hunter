import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, type Page, type Route, test } from '@playwright/test';
import { Buffer } from 'node:buffer';

type MockBackendOptions = Readonly<{
    rooms?: readonly MockGroupSnapshot[];
    relicSnapshot?: RelicSnapshot;
    commandSnapshot?: RelicSnapshot;
    commandSnapshots?: readonly RelicSnapshot[];
    commandResponse?(body: unknown): RelicSnapshot;
    requests?: string[];
    commandBodies?: unknown[];
}>;
type RelicPhase = 'lobby' | 'planning' | 'review' | 'finished';
type SceneBaselineScenario = Readonly<{
    name: string;
    mode: 'opening' | 'room';
    viewport: Readonly<{ width: number; height: number }>;
    snapshot?: RelicSnapshot;
    commandSnapshot?: RelicSnapshot;
    onlineMemberCount?: number;
    expectedCameraMode?: string;
    expectedLightingPreset?: string;
    wait?(page: Page): Promise<void>;
}>;
type SceneBaselineMetric = Awaited<ReturnType<typeof sceneCanvasMetrics>> & Readonly<{
    scenario: string;
}>;

const SESSION_TTL_MS = 60 * 60 * 1_000;
const session = {
    clientId: 'alice-client',
    accessToken: 'alice-token',
    username: 'alice',
    sessionId: 'alice-session',
    expiresAtEpochMs: Date.now() + SESSION_TTL_MS,
};
const SCENE_BASELINE_DIR = 'apps/relic-hunters-v1/baseline/screenshots/scene-upgrades';
const WRITE_SCENE_BASELINES = process.env.RELIC_SCENE_BASELINE_WRITE === '1' ||
    process.env.RELIC_SCENE_BASELINE_WRITE === 'true';

test.describe('Relic Hunters web app', () => {
    test('renders a Babylon opening scene before authentication', async ({ page }) => {
        await installBrowserDoubles(page);
        await mockBackend(page, { rooms: [] });

        await page.goto('/');

        const canvas = page.locator('canvas.relic-scene');
        await expect(canvas).toBeVisible();
        await expect(page.locator('.relic-scene-fallback')).toHaveCount(0);
        await expect.poll(() => sceneHasVisiblePixels(page)).toBe(true);
        await expect(page.getByRole('button', { name: 'Login' })).toBeVisible();
    });

    test('captures scene upgrade baselines and verifies canvas render contracts', async ({ browser }) => {
        test.slow();
        test.setTimeout(240_000);
        const baselineMetrics: SceneBaselineMetric[] = [];
        const scenarios: readonly SceneBaselineScenario[] = [
            {
                name: 'opening-desktop',
                mode: 'opening',
                viewport: { width: 1280, height: 720 },
                expectedLightingPreset: 'day',
            },
            {
                name: 'lobby-desktop',
                mode: 'room',
                viewport: { width: 1280, height: 720 },
                snapshot: relicSnapshotWithPlayers(1, 'lobby'),
                expectedLightingPreset: 'day',
                wait: async (page) => {
                    await expect(page.getByText('Keeper: Alice')).toBeVisible();
                    await expect(page.getByRole('button', { name: /^Start$/ })).toBeVisible();
                },
            },
            {
                name: 'planning-desktop',
                mode: 'room',
                viewport: { width: 1280, height: 720 },
                snapshot: relicSnapshotWithPlayers(1, 'planning', { includeStorage: true }),
                expectedCameraMode: 'tactical',
                expectedLightingPreset: 'day',
                wait: async (page) => {
                    await expect(page.getByLabel('Current turn summary')).toContainText('Choose one plan');
                    await expect(page.getByRole('button', { name: 'Submit Plan' })).toBeVisible();
                },
            },
            {
                name: 'planning-mobile',
                mode: 'room',
                viewport: { width: 390, height: 844 },
                snapshot: relicSnapshotWithPlayers(1, 'planning', { includeStorage: true }),
                expectedCameraMode: 'tactical',
                expectedLightingPreset: 'day',
                wait: async (page) => {
                    await expect(page.getByLabel('Current turn summary')).toContainText('Choose one plan');
                    await expect(page.getByRole('button', { name: 'Submit Plan' })).toBeVisible();
                },
            },
            {
                name: 'waiting-locked-desktop',
                mode: 'room',
                viewport: { width: 1280, height: 720 },
                snapshot: relicSnapshotWithPlayers(2, 'planning', {
                    submittedPlayerIds: ['alice-session'],
                }),
                onlineMemberCount: 2,
                expectedCameraMode: 'tactical',
                expectedLightingPreset: 'day',
                wait: async (page) => {
                    await expect(page.getByLabel('Current turn summary')).toContainText('Plan Locked');
                    await expect(page.getByLabel('Round plan')).toContainText('1 hunter still choosing');
                },
            },
            {
                name: 'split-party-identities-desktop',
                mode: 'room',
                viewport: { width: 1280, height: 720 },
                snapshot: relicSnapshotWithPlayers(4, 'planning', {
                    includeFullMap: true,
                    playerRooms: {
                        'alice-session': 'entrance',
                        'bob-session': 'shrine',
                        'cara-session': 'monster',
                        'dain-session': 'exit',
                    },
                    playerRelicIds: {
                        'dain-session': ['sun-disk'],
                    },
                    submittedPlayerIds: ['alice-session', 'cara-session'],
                }),
                onlineMemberCount: 4,
                expectedCameraMode: 'tactical',
                expectedLightingPreset: 'day',
                wait: async (page) => {
                    await expect(page.getByLabel('Current turn summary')).toContainText('Plan Locked');
                    await expect(page.getByLabel('Castle room map')).toContainText('Shrine');
                    await expect(page.getByLabel('Castle room map')).toContainText('Monster');
                    await expect(page.getByLabel('Castle room map')).toContainText('Treasure');
                    await expect(page.getByLabel('Room occupants')).toContainText('1 hunter here / 3 elsewhere');
                },
            },
            {
                name: 'resolved-timeline-desktop',
                mode: 'room',
                viewport: { width: 1280, height: 720 },
                snapshot: relicSnapshotWithPlayers(1, 'planning', {
                    includeStorage: true,
                    playerRoomId: 'storage',
                }),
                commandSnapshot: resolvedStorageSearchSnapshot(),
                expectedCameraMode: 'tactical',
                expectedLightingPreset: 'lantern',
                wait: async (page) => {
                    await expect(page.getByLabel('Current turn summary')).toContainText(
                        'Choose one plan',
                        { timeout: 15_000 },
                    );
                    await expect(page.getByRole('button', { name: 'Submit Plan' })).toBeEnabled();
                    await page.getByRole('button', { name: 'Submit Plan' }).click();
                    await expect(page.getByLabel('Turn timeline')).toContainText(
                        'Alice searched the crates and marked a false supply trail.',
                        { timeout: 15_000 },
                    );
                },
            },
            {
                name: 'finished-desktop',
                mode: 'room',
                viewport: { width: 1280, height: 720 },
                snapshot: finishedRelicSnapshot(),
                expectedLightingPreset: 'sunset',
                wait: async (page) => {
                    await expect(page.getByText('The Heart Relic has chosen')).toBeVisible();
                    await expect(page.getByText('Final score: 5')).toBeVisible();
                },
            },
        ];

        for (const scenario of scenarios) {
            const context = await browser.newContext({
                viewport: scenario.viewport,
                deviceScaleFactor: 2,
            });
            const page = await context.newPage();
            try {
                await installBrowserDoubles(page);
                if (scenario.mode === 'room') {
                    await restoreRoomSession(page);
                }
                await mockBackend(page, {
                    rooms: scenario.mode === 'room'
                        ? [groupSnapshot({ onlineMemberCount: scenario.onlineMemberCount ?? 1 })]
                        : [],
                    relicSnapshot: scenario.snapshot ?? emptyRelicSnapshot(),
                    commandSnapshot: scenario.commandSnapshot,
                });

                await page.goto('http://127.0.0.1:5175/');
                if (scenario.mode === 'room') {
                    await openListedRoomIfNeeded(page);
                    await scenario.wait?.(page);
                } else {
                    await expect(page.getByRole('button', { name: 'Login' })).toBeVisible();
                }

                await expect.poll(() => sceneCanvasMetrics(page), {
                    message: `${scenario.name} canvas should render visible high-DPI pixels`,
                    timeout: 20_000,
                }).toMatchObject({
                    ready: true,
                    devicePixelRatio: 2,
                    highDpi: true,
                    hasRenderedFrame: true,
                    ...(scenario.expectedCameraMode ? { cameraMode: scenario.expectedCameraMode } : {}),
                    ...(scenario.expectedLightingPreset
                        ? { lightingPreset: scenario.expectedLightingPreset }
                        : {}),
                    assetPipeline: 'procedural',
                });

                const metrics = await sceneCanvasMetrics(page);
                expect(metrics.meshCount).toBeGreaterThan(0);
                expect(metrics.materialCount).toBeGreaterThan(0);
                if (scenario.expectedCameraMode) {
                    expect(metrics.activeMeshCount).toBeGreaterThan(0);
                    expect(metrics.readyMs).toBeGreaterThan(0);
                }
                baselineMetrics.push({ scenario: scenario.name, ...metrics });

                const screenshot = await captureSceneBaseline(page, scenario.name);
                expect(screenshot.byteLength).toBeGreaterThan(10_000);
            } finally {
                await context.close();
            }
        }

        if (WRITE_SCENE_BASELINES) {
            mkdirSync(SCENE_BASELINE_DIR, { recursive: true });
            writeFileSync(
                `${SCENE_BASELINE_DIR}/scene-upgrade-metrics.json`,
                `${JSON.stringify(baselineMetrics, null, 2)}\n`,
            );
        }
    });

    test('registers a player and shows the connected lobby controls', async ({ page }) => {
        await installBrowserDoubles(page);
        await mockBackend(page, { rooms: [] });

        await page.goto('/');
        await page.getByRole('button', { name: 'Register' }).click();
        await page.getByLabel('Username').fill('alice');
        await page.getByLabel('Display name').fill('Alice');
        await page.getByLabel('Password').fill('correct-horse');
        await page.getByRole('button', { name: 'Create Hunter' }).click();

        await expect(page.getByRole('button', { name: 'New Room' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Atmosphere' })).toBeVisible();
        await expect(page.getByText('alice', { exact: true })).toBeVisible();
    });

    test('captures core lobby layouts at desktop and mobile viewports', async ({ page }) => {
        await installBrowserDoubles(page);
        await mockBackend(page, {
            rooms: [groupSnapshot({ onlineMemberCount: 1 })],
            relicSnapshot: emptyRelicSnapshot(),
        });

        await page.setViewportSize({ width: 1280, height: 720 });
        await page.goto('/');
        await page.getByRole('button', { name: 'Register' }).click();
        await page.getByLabel('Username').fill('alice');
        await page.getByLabel('Display name').fill('Alice');
        await page.getByLabel('Password').fill('correct-horse');
        await page.getByRole('button', { name: 'Create Hunter' }).click();
        await expect(page.getByRole('button', { name: 'Relic Hunters Expedition' })).toBeVisible();

        const desktop = await page.screenshot({ animations: 'disabled' });
        expect(desktop.byteLength).toBeGreaterThan(10_000);

        await page.setViewportSize({ width: 390, height: 844 });
        await expect(page.getByRole('button', { name: 'Relic Hunters Expedition' })).toBeVisible();
        await expect.poll(() => page.locator('.hud-region-side').evaluate((el) => getComputedStyle(el).overflow))
            .toBe('visible');
        const mobile = await page.screenshot({ animations: 'disabled' });
        expect(mobile.byteLength).toBeGreaterThan(10_000);
    });

    test('keeps large-screen side menus reachable', async ({ page }) => {
        test.slow();
        const room = groupSnapshot({ onlineMemberCount: 1 });
        await page.setViewportSize({ width: 1920, height: 1080 });
        await installBrowserDoubles(page);
        await mockBackend(page, {
            rooms: [room],
            relicSnapshot: relicSnapshotWithPlayers(1, 'planning'),
        });
        await page.addInitScript((storedSession) => {
            window.localStorage.setItem('auth.session', JSON.stringify(storedSession));
        }, session);

        await page.goto('/');
        await page.getByRole('button', { name: 'Relic Hunters Expedition' }).click({ force: true });

        const menu = page.getByRole('navigation', { name: 'Side panel sections' });
        await expect(menu.getByRole('button', { name: 'Rooms' })).toBeVisible();
        await expect(menu.getByRole('button', { name: 'Plan' })).toBeVisible();
        await expect(menu.getByRole('button', { name: 'Map' })).toBeVisible();
        await expect(menu.getByRole('button', { name: 'Intel' })).toBeVisible();

        const sideWidth = await page.locator('.hud-region-side').evaluate((el) => el.getBoundingClientRect().width);
        expect(sideWidth).toBeGreaterThan(700);
        const bottomRight = await page.locator('.hud-region-bottom').evaluate((el) => el.getBoundingClientRect().right);
        const sideLeft = await page.locator('.hud-region-side').evaluate((el) => el.getBoundingClientRect().left);
        expect(bottomRight).toBeLessThanOrEqual(sideLeft);

        const scrollMetrics = await page.locator('.side-panel').evaluate((el) => {
            el.scrollTop = el.scrollHeight;
            const panelBox = el.getBoundingClientRect();
            const lastChildBox = el.lastElementChild?.getBoundingClientRect();
            return {
                clientHeight: el.clientHeight,
                scrollHeight: el.scrollHeight,
                scrollTop: el.scrollTop,
                panelBottom: panelBox.bottom,
                lastChildBottom: lastChildBox?.bottom ?? panelBox.bottom,
            };
        });
        expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
        expect(scrollMetrics.scrollTop).toBeGreaterThan(0);
        expect(scrollMetrics.lastChildBottom).toBeLessThanOrEqual(scrollMetrics.panelBottom + 1);
    });

    test('joins a room and prompts when expedition players no longer match online party', async ({ page }) => {
        const room = groupSnapshot({ onlineMemberCount: 1 });
        await installBrowserDoubles(page);
        await mockBackend(page, {
            rooms: [room],
            relicSnapshot: relicSnapshotWithPlayers(2),
        });

        await page.goto('/');
        await page.getByRole('button', { name: 'Register' }).click();
        await page.getByLabel('Username').fill('alice');
        await page.getByLabel('Display name').fill('Alice');
        await page.getByLabel('Password').fill('correct-horse');
        await page.getByRole('button', { name: 'Create Hunter' }).click();
        await page.getByRole('button', { name: 'Relic Hunters Expedition' }).click({ force: true });

        await expect(page.getByText('Party Changed')).toBeVisible();
        await expect(page.getByText('1/2 hunters are online')).toBeVisible();
        await expect(page.getByText(/Offline joined hunters can hold a round until the timer expires/)).toBeVisible();
        await expect(page.getByRole('button', { name: 'Start Over' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Keep Going' })).toBeVisible();
    });

    test('can reset when a joined expedition has lost players', async ({ page }) => {
        const room = groupSnapshot({ onlineMemberCount: 1 });
        await installBrowserDoubles(page);
        await mockBackend(page, {
            rooms: [room],
            relicSnapshot: relicSnapshotWithPlayers(2),
        });

        await page.goto('/');
        await page.getByRole('button', { name: 'Register' }).click();
        await page.getByLabel('Username').fill('alice');
        await page.getByLabel('Display name').fill('Alice');
        await page.getByLabel('Password').fill('correct-horse');
        await page.getByRole('button', { name: 'Create Hunter' }).click();
        await page.getByRole('button', { name: 'Relic Hunters Expedition' }).click({ force: true });
        await expect(page.getByText('Party Changed')).toBeVisible();

        await page.getByRole('button', { name: 'Start Over' }).click();

        await expect(page.getByText('Party Changed')).toBeHidden();
        await expect(page.getByRole('button', { name: /Join as/ })).toBeVisible();
    });

    test('can continue a mismatched expedition without resetting it', async ({ page }) => {
        const room = groupSnapshot({ onlineMemberCount: 1 });
        const requests: string[] = [];
        await installBrowserDoubles(page);
        await mockBackend(page, {
            rooms: [room],
            relicSnapshot: relicSnapshotWithPlayers(2),
            requests,
        });

        await page.goto('/');
        await page.getByRole('button', { name: 'Register' }).click();
        await page.getByLabel('Username').fill('alice');
        await page.getByLabel('Display name').fill('Alice');
        await page.getByLabel('Password').fill('correct-horse');
        await page.getByRole('button', { name: 'Create Hunter' }).click();
        await page.getByRole('button', { name: 'Relic Hunters Expedition' }).click();
        await expect(page.getByText('Party Changed')).toBeVisible();

        await page.getByRole('button', { name: 'Keep Going' }).click();

        await expect(page.getByText('Party Changed')).toBeHidden();
        expect(requests).not.toContain('POST /api/relic/games/room-1/reset');
    });

    test('shows lobby membership and start blockers when online members have not joined', async ({ page }) => {
        const room = groupSnapshot({ onlineMemberCount: 2 });
        await installBrowserDoubles(page);
        await mockBackend(page, {
            rooms: [room],
            relicSnapshot: relicSnapshotWithPlayers(1),
        });

        await page.goto('/');
        await page.getByRole('button', { name: 'Register' }).click();
        await page.getByLabel('Username').fill('alice');
        await page.getByLabel('Display name').fill('Alice');
        await page.getByLabel('Password').fill('correct-horse');
        await page.getByRole('button', { name: 'Create Hunter' }).click();
        await page.getByRole('button', { name: 'Relic Hunters Expedition' }).click();

        await expect(page.getByText('Keeper: Alice')).toBeVisible();
        await expect(page.getByText('Online room members', { exact: true })).toBeVisible();
        await expect(page.getByText('Joined expedition hunters', { exact: true })).toBeVisible();
        await expect(page.getByText('1 online room member still needs to join.')).toBeVisible();
        await expect(page.getByRole('button', { name: /^Start$/ })).toBeDisabled();
    });

    test('sends room-scoped relic commands from the browser UI', async ({ page }) => {
        const room = groupSnapshot({ onlineMemberCount: 1 });
        const commandBodies: unknown[] = [];
        await installBrowserDoubles(page);
        await mockBackend(page, {
            rooms: [room],
            relicSnapshot: emptyRelicSnapshot(),
            commandBodies,
        });

        await page.goto('/');
        await page.getByRole('button', { name: 'Register' }).click();
        await page.getByLabel('Username').fill('alice');
        await page.getByLabel('Display name').fill('Alice');
        await page.getByLabel('Password').fill('correct-horse');
        await page.getByRole('button', { name: 'Create Hunter' }).click();
        await page.getByRole('button', { name: 'Relic Hunters Expedition' }).click();

        await page.getByRole('button', { name: /Join as/ }).click();
        await page.getByRole('button', { name: 'Start' }).click();

        expect(commandBodies).toHaveLength(2);
        expect(commandBodies[0]).toMatchObject({
            protocolVersion: 1,
            kind: 'join-expedition',
            gameId: 'room-1',
            username: 'alice',
            characterId: 'kael-ironstride',
        });
        expect(commandBodies[1]).toMatchObject({
            protocolVersion: 1,
            kind: 'start-expedition',
            gameId: 'room-1',
            username: 'alice',
        });
    });

    test('can force-resolve a timed-out round from the browser UI', async ({ page }) => {
        test.setTimeout(60_000);
        const room = groupSnapshot({ onlineMemberCount: 2 });
        const commandBodies: unknown[] = [];
        await installBrowserDoubles(page);
        await mockBackend(page, {
            rooms: [room],
            relicSnapshot: relicSnapshotWithPlayers(2, 'planning', {
                submittedPlayerIds: ['alice-session'],
                roundStartedAtEpochMs: Date.now() - 90_000,
                roundTimeLimitMs: 60_000,
            }),
            commandBodies,
            commandSnapshot: resolvedSearchSnapshot(),
        });

        await page.goto('/');
        await page.getByRole('button', { name: 'Register' }).click();
        await page.getByLabel('Username').fill('alice');
        await page.getByLabel('Display name').fill('Alice');
        await page.getByLabel('Password').fill('correct-horse');
        await page.getByRole('button', { name: 'Create Hunter' }).click();
        await page.getByRole('button', { name: 'Relic Hunters Expedition' }).click();

        await expect(page.getByText('1 timed-out hunter.')).toBeVisible();
        await page.getByRole('button', { name: 'Resolve Timed-Out Round' }).click();

        expect(commandBodies).toHaveLength(1);
        expect(commandBodies[0]).toMatchObject({
            protocolVersion: 1,
            kind: 'force-resolve-round',
            gameId: 'room-1',
            username: 'alice',
        });
    });

    test('creates a room and completes the first playable turn through the browser UI', async ({ page }) => {
        test.setTimeout(60_000);
        const commandBodies: unknown[] = [];
        await installBrowserDoubles(page);
        await mockBackend(page, {
            rooms: [],
            relicSnapshot: emptyRelicSnapshot(),
            commandBodies,
            commandResponse: (body) => {
                const kind = (body as { kind?: string } | undefined)?.kind;
                if (kind === 'join-expedition') return relicSnapshotWithPlayers(1);
                if (kind === 'start-expedition') return relicSnapshotWithPlayers(1, 'planning');
                if (kind === 'submit-action') return resolvedSearchSnapshot();
                return relicSnapshotWithPlayers(1);
            },
        });

        await page.goto('/');
        await page.getByRole('button', { name: 'Register' }).click();
        await page.getByLabel('Username').fill('alice');
        await page.getByLabel('Display name').fill('Alice');
        await page.getByLabel('Password').fill('correct-horse');
        await page.getByRole('button', { name: 'Create Hunter' }).click();

        await page.getByRole('button', { name: 'New Room' }).click();
        await expect(page.getByRole('button', { name: /Join as/ })).toBeVisible();

        await page.getByRole('button', { name: /Join as/ }).click();
        await expect(page.getByText('Keeper: Alice')).toBeVisible();
        await expect(page.locator('.lobby-begin-btn')).toBeEnabled();
        await page.locator('.lobby-begin-btn').click();
        await expect.poll(() => commandBodies.length).toBe(2);
        expect((commandBodies.at(-1) as { kind?: string }).kind).toBe('start-expedition');

        await expect(page.getByLabel('Current turn summary')).toContainText('Choose one plan', { timeout: 15_000 });
        await page.getByRole('button', { name: 'Submit Plan' }).click();

        await expect(page.getByLabel('Current turn summary')).toContainText('Choose one plan', { timeout: 15_000 });
        const timeline = page.getByLabel('Turn timeline');
        await expect(timeline).toContainText('Reveal', { timeout: 20_000 });
        await expect(timeline).toContainText('Your Action', { timeout: 20_000 });
        await expect(timeline).toContainText('Result', { timeout: 20_000 });
        await expect(timeline).toContainText('Alice searched the Entrance.', { timeout: 20_000 });
        expect(commandBodies.map((body) => (body as { kind?: string }).kind)).toEqual([
            'join-expedition',
            'start-expedition',
            'submit-action',
        ]);
    });

    test('renders a nonblank Babylon scene and tolerates pointer look', async ({ page }) => {
        test.setTimeout(60_000);
        const room = groupSnapshot({ onlineMemberCount: 1 });
        await installBrowserDoubles(page);
        await mockBackend(page, {
            rooms: [room],
            relicSnapshot: relicSnapshotWithPlayers(1, 'planning'),
        });

        await page.goto('/');
        await page.getByRole('button', { name: 'Register' }).click();
        await page.getByLabel('Username').fill('alice');
        await page.getByLabel('Display name').fill('Alice');
        await page.getByLabel('Password').fill('correct-horse');
        await page.getByRole('button', { name: 'Create Hunter' }).click();
        await page.getByRole('button', { name: 'Relic Hunters Expedition' }).click();

        const canvas = page.locator('canvas.relic-scene');
        await expect(canvas).toBeVisible();
        await expect.poll(() => sceneHasVisiblePixels(page)).toBe(true);
        await expect(page.getByRole('group', { name: 'Camera controls' })).toBeVisible();

        await page.getByRole('button', { name: 'Avatar' }).click();
        await expect.poll(() => canvas.evaluate((node) =>
            (node as HTMLCanvasElement).dataset.cameraControl
        )).toBe('avatar');
        await page.getByRole('button', { name: 'Tactical overview' }).click();
        await expect.poll(() => canvas.evaluate((node) =>
            (node as HTMLCanvasElement).dataset.cameraControl
        )).toBe('tactical');
        await page.getByRole('button', { name: 'Fly over rooms' }).click();
        await expect.poll(() => canvas.evaluate((node) =>
            (node as HTMLCanvasElement).dataset.cameraControl
        )).toBe('flyover');

        const box = await canvas.boundingBox();
        expect(box).not.toBeNull();
        if (box) {
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.down();
            await page.mouse.move(box.x + box.width / 2 + 48, box.y + box.height / 2 + 24);
            await page.mouse.up();
        }

        await expect(page.getByRole('button', { name: 'Atmosphere' }).first()).toBeVisible();
    });

    test('scene doorway prompt primes a move plan without submitting it', async ({ page }) => {
        test.setTimeout(60_000);
        const room = groupSnapshot({ onlineMemberCount: 1 });
        const commandBodies: unknown[] = [];
        await installBrowserDoubles(page);
        await mockBackend(page, {
            rooms: [room],
            relicSnapshot: relicSnapshotWithPlayers(1, 'planning'),
            commandBodies,
        });

        await page.goto('/');
        await page.getByRole('button', { name: 'Register' }).click();
        await page.getByLabel('Username').fill('alice');
        await page.getByLabel('Display name').fill('Alice');
        await page.getByLabel('Password').fill('correct-horse');
        await page.getByRole('button', { name: 'Create Hunter' }).click();
        await page.getByRole('button', { name: 'Relic Hunters Expedition' }).click();

        const canvas = page.locator('canvas.relic-scene');
        await expect(canvas).toBeVisible();
        await expect.poll(() => sceneHasVisiblePixels(page)).toBe(true);

        await page.keyboard.down('w');
        const movePrompt = page.getByRole('button', { name: /Move to Hallway/ });
        await expect(movePrompt).toBeVisible({ timeout: 15_000 });
        await movePrompt.click();
        await page.keyboard.up('w');

        await expect(page.getByText('Step into an adjacent room')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Submit Plan' })).toBeEnabled();
        expect(commandBodies).toHaveLength(0);
    });

    test('scene objective panel primes the recommended room action', async ({ page }) => {
        test.setTimeout(60_000);
        const room = groupSnapshot({ onlineMemberCount: 1 });
        const commandBodies: unknown[] = [];
        await installBrowserDoubles(page);
        await mockBackend(page, {
            rooms: [room],
            relicSnapshot: relicSnapshotWithPlayers(1, 'planning'),
            commandBodies,
        });

        await page.goto('/');
        await page.getByRole('button', { name: 'Register' }).click();
        await page.getByLabel('Username').fill('alice');
        await page.getByLabel('Display name').fill('Alice');
        await page.getByLabel('Password').fill('correct-horse');
        await page.getByRole('button', { name: 'Create Hunter' }).click();
        await page.getByRole('button', { name: 'Relic Hunters Expedition' }).click();

        const objective = page.locator('[aria-label="Room objective"]');
        await expect(objective.getByText('Move to Hallway')).toBeVisible();
        await objective.getByRole('button', { name: 'Prime Move' }).click();

        await expect(page.getByLabel('Round plan').getByText('Step into an adjacent room'))
            .toBeVisible({ timeout: 15_000 });
        await expect(objective.getByText('Submit the plan to commit this turn-based move.')).toBeVisible();
        expect(commandBodies).toHaveLength(0);
    });

    test('scene objective panel exposes escape when the hunter reaches the exit', async ({ page }) => {
        test.setTimeout(60_000);
        const room = groupSnapshot({ onlineMemberCount: 1 });
        const commandBodies: unknown[] = [];
        await installBrowserDoubles(page);
        await mockBackend(page, {
            rooms: [room],
            relicSnapshot: relicSnapshotWithPlayers(1, 'planning', {
                carryRelic: true,
                includeExit: true,
                playerRoomId: 'exit',
            }),
            commandBodies,
        });

        await page.goto('/');
        await page.getByRole('button', { name: 'Register' }).click();
        await page.getByLabel('Username').fill('alice');
        await page.getByLabel('Display name').fill('Alice');
        await page.getByLabel('Password').fill('correct-horse');
        await page.getByRole('button', { name: 'Create Hunter' }).click();
        await page.getByRole('button', { name: 'Relic Hunters Expedition' }).click();

        const objective = page.locator('[aria-label="Room objective"]');
        await expect(objective.getByText('Escape with your relics')).toBeVisible();
        await objective.getByRole('button', { name: 'Prime Escape' }).click();

        await expect(page.getByText('Leave from the Exit with your relics')).toBeVisible();
        await expect(objective.getByText('Escape is primed')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Submit Plan' })).toBeEnabled();
        expect(commandBodies).toHaveLength(0);
    });

    test('shows party coordination and map occupancy for a split party', async ({ page }) => {
        test.setTimeout(60_000);
        const room = groupSnapshot({ onlineMemberCount: 4 });
        await installBrowserDoubles(page);
        await mockBackend(page, {
            rooms: [room],
            relicSnapshot: relicSnapshotWithPlayers(4, 'planning', {
                includeStorage: true,
                playerRooms: {
                    'alice-session': 'storage',
                    'bob-session': 'storage',
                    'cara-session': 'trap',
                    'dain-session': 'hallway',
                },
                playerRelicIds: {
                    'bob-session': ['sun-disk'],
                },
                playerScores: {
                    'bob-session': 6,
                    'cara-session': 1,
                },
                submittedPlayerIds: ['alice-session', 'cara-session'],
            }),
        });

        await page.goto('/');
        await page.getByRole('button', { name: 'Register' }).click();
        await page.getByLabel('Username').fill('alice');
        await page.getByLabel('Display name').fill('Alice');
        await page.getByLabel('Password').fill('correct-horse');
        await page.getByRole('button', { name: 'Create Hunter' }).click();
        await page.getByRole('button', { name: 'Relic Hunters Expedition' }).click();

        const occupants = page.getByLabel('Room occupants');
        await expect(occupants).toContainText('2 hunters here / 2 elsewhere', { timeout: 15_000 });
        await expect(occupants).toContainText('2/4 plans locked');
        await expect(occupants).toContainText('Storage');
        await expect(occupants).toContainText('Bob');
        await expect(occupants).toContainText('1 relic');
        await expect(occupants).toContainText('Searching makes noise for 2 hunters in Storage.');

        await expect(page.getByLabel('2 hunters in Storage')).toBeVisible();
        await expect(page.getByLabel('1 hunter in Trap Room')).toBeVisible();
        await expect(page.getByLabel('1 hunter in Hallway')).toBeVisible();

        await page.getByRole('button', { name: /Steal/ }).click();

        await expect(occupants).toContainText('Steal is possible here: Bob carries 1 relic.');
    });

    test('resolved search marks the room objective as investigated', async ({ page }) => {
        test.setTimeout(60_000);
        const room = groupSnapshot({ onlineMemberCount: 1 });
        await installBrowserDoubles(page);
        await mockBackend(page, {
            rooms: [room],
            relicSnapshot: relicSnapshotWithPlayers(1, 'planning', {
                includeStorage: true,
                playerRoomId: 'storage',
            }),
            commandSnapshot: relicSnapshotWithPlayers(1, 'planning', {
                includeStorage: true,
                playerRoomId: 'storage',
                roomInvestigations: [
                    {
                        roomId: 'storage',
                        searchedByPlayerId: 'alice-session',
                        searchedByUsername: 'Alice',
                        searchedAtRound: 1,
                        searchedAtEpochMs: Date.now(),
                        result: 'empty',
                        summary: 'The crates held a torn supply map, but no relic.',
                        hint: 'The supply marks point back toward the Entrance and onward through the Trap Room.',
                        effect: 'map-fragment',
                        revealedRoomId: 'trap',
                    },
                ],
                events: [
                    {
                        id: 'event-reveal-1',
                        round: 1,
                        type: 'action_revealed',
                        message: 'Round 1 actions are revealed.',
                        animationCue: {
                            type: 'noise_pulse',
                            durationMs: 620,
                            intensity: 'low',
                        },
                        tone: 'mystery',
                        createdAtEpochMs: Date.now(),
                    },
                    {
                        id: 'event-search-1',
                        round: 1,
                        type: 'player_searched',
                        message: 'Alice searched the crates and marked a false supply trail.',
                        animationCue: {
                            type: 'search_altar',
                            playerId: 'alice-session',
                            roomId: 'storage',
                            durationMs: 700,
                            intensity: 'low',
                        },
                        tone: 'mystery',
                        createdAtEpochMs: Date.now(),
                    },
                    {
                        id: 'event-noise-1',
                        round: 1,
                        type: 'noise_pulse',
                        message: 'The ruin hears 2 noise.',
                        animationCue: {
                            type: 'noise_pulse',
                            durationMs: 900,
                            intensity: 'low',
                        },
                        tone: 'mystery',
                        createdAtEpochMs: Date.now(),
                    },
                    {
                        id: 'event-round-2',
                        round: 1,
                        type: 'round_started',
                        message: 'Round 2 begins.',
                        tone: 'mystery',
                        createdAtEpochMs: Date.now(),
                    },
                ],
                round: 2,
            }),
        });

        await page.goto('/');
        await page.getByRole('button', { name: 'Register' }).click();
        await page.getByLabel('Username').fill('alice');
        await page.getByLabel('Display name').fill('Alice');
        await page.getByLabel('Password').fill('correct-horse');
        await page.getByRole('button', { name: 'Create Hunter' }).click();
        await page.getByRole('button', { name: 'Relic Hunters Expedition' }).click();

        const objective = page.locator('[aria-label="Room objective"]');
        await expect(objective.getByText('Search the crates')).toBeVisible();
        await objective.getByRole('button', { name: 'Prime Search' }).click();
        await page.getByRole('button', { name: 'Submit Plan' }).click();

        await expect(objective.getByText('Clue trail marked')).toBeVisible();
        await expect(objective.getByText('The crates held a torn supply map, but no relic.')).toBeVisible();
        await expect(objective.getByText('Follow the map fragment toward Trap Room')).toBeVisible();
        await expect(objective.getByText('Next step: Move to Trap Room. The supply marks point back toward the Entrance and onward through the Trap Room.')).toBeVisible();
        await expect(page.getByLabel('Current turn summary')).toContainText('Choose one plan');
        const timeline = page.getByLabel('Turn timeline');
        await expect(timeline).toContainText('Your Action');
        await expect(timeline).toContainText('Castle Reaction');
        await expect(timeline).toContainText('Result');
        await expect(timeline).toContainText('Alice searched the crates and marked a false supply trail.');
        await expect(page.getByLabel('Discovered clue trails')).toContainText('Storage - Trap Room');
        await expect(page.getByLabel('Discovered clue trails')).toContainText('The crates held a torn supply map, but no relic.');
        await expect(page.getByLabel('Castle room map').getByRole('button', { name: 'Trap Room' })).toHaveClass(/clue-target/);
    });

    test('shows the review phase before continuing to the next turn', async ({ page }) => {
        test.setTimeout(60_000);
        const commandBodies: unknown[] = [];
        await installBrowserDoubles(page);
        await mockBackend(page, {
            rooms: [groupSnapshot({ onlineMemberCount: 1 })],
            relicSnapshot: relicSnapshotWithPlayers(1, 'planning', {
                includeStorage: true,
                playerRoomId: 'storage',
            }),
            commandBodies,
            commandResponse: (body) => {
                if (isCommandKind(body, 'continue-review')) {
                    return continuedStoragePlanningSnapshot();
                }
                return reviewStorageSearchSnapshot();
            },
        });

        await page.goto('/');
        await page.getByRole('button', { name: 'Register' }).click();
        await page.getByLabel('Username').fill('alice');
        await page.getByLabel('Display name').fill('Alice');
        await page.getByLabel('Password').fill('correct-horse');
        await page.getByRole('button', { name: 'Create Hunter' }).click();
        await page.getByRole('button', { name: 'Relic Hunters Expedition' }).click();

        await expect(page.getByRole('button', { name: 'Submit Plan' })).toBeEnabled();
        await page.getByRole('button', { name: 'Submit Plan' }).click();

        await expect(page.getByLabel('Current turn summary')).toContainText('Plans revealed');
        await expect(page.getByLabel('Round review')).toContainText('Watch the revealed plans');
        await expect(page.getByRole('button', { name: 'Submit Plan' })).toHaveCount(0);
        await expect(page.getByLabel('Turn timeline')).toContainText(
            'Alice searched the crates and marked a false supply trail.',
        );

        await page.getByRole('button', { name: 'Continue to next turn' }).click();

        await expect(page.getByLabel('Current turn summary')).toContainText('Choose one plan');
        await expect(page.getByRole('button', { name: 'Submit Plan' })).toBeEnabled();
        expect(commandBodies.some((body) => isCommandKind(body, 'continue-review'))).toBe(true);
    });

    test('Rallar browser bootstrap reads server config, state snapshots, and opens WebSocket', async ({ page }) => {
        const requests: string[] = [];
        await installBrowserDoubles(page);
        await mockBackend(page, { rooms: [], requests });

        await page.goto('/');
        await page.getByRole('button', { name: 'Register' }).click();
        await page.getByLabel('Username').fill('alice');
        await page.getByLabel('Display name').fill('Alice');
        await page.getByLabel('Password').fill('correct-horse');
        await page.getByRole('button', { name: 'Create Hunter' }).click();
        await expect(page.getByRole('button', { name: 'New Room' })).toBeVisible();

        expect(requests).toContain('GET /api/config');
        expect(requests).toContain('POST /api/auth/ws-ticket');
        expect(requests).toContain('GET /api/state/apps/rallar-server/workspaces/default/clients');
        expect(requests).toContain('GET /api/state/apps/rallar-server/workspaces/default/groups');

        const wsUrls = await page.evaluate(() =>
            (window as unknown as { __rallarWsUrls?: string[] }).__rallarWsUrls ?? []
        );
        expect(wsUrls).toContain('ws://127.0.0.1:5175/api/ws/alice-session?ticket=test-ticket');
    });
});

async function installBrowserDoubles(page: Page): Promise<void> {
    await page.addInitScript(() => {
        class FakeWebSocket extends EventTarget {
            static readonly CONNECTING = 0;
            static readonly OPEN = 1;
            static readonly CLOSING = 2;
            static readonly CLOSED = 3;
            readonly url: string;
            readyState = FakeWebSocket.CONNECTING;
            binaryType = 'blob';
            onopen: ((event: Event) => void) | null = null;
            onclose: ((event: CloseEvent) => void) | null = null;
            onerror: ((event: Event) => void) | null = null;
            onmessage: ((event: MessageEvent) => void) | null = null;

            constructor(url: string) {
                super();
                this.url = url;
                const target = window as unknown as { __rallarWsUrls?: string[] };
                target.__rallarWsUrls ??= [];
                target.__rallarWsUrls.push(url);
                window.setTimeout(() => {
                    this.readyState = FakeWebSocket.OPEN;
                    const event = new Event('open');
                    this.dispatchEvent(event);
                    this.onopen?.(event);
                }, 0);
            }

            send(data: unknown): void {
                const target = window as unknown as { __rallarWsOutbox?: unknown[] };
                target.__rallarWsOutbox ??= [];
                target.__rallarWsOutbox.push(data);
            }

            close(code = 1000, reason = ''): void {
                this.readyState = FakeWebSocket.CLOSED;
                const event = new CloseEvent('close', { code, reason });
                this.dispatchEvent(event);
                this.onclose?.(event);
            }
        }

        Object.defineProperty(window, 'WebSocket', {
            configurable: true,
            writable: true,
            value: FakeWebSocket,
        });
    });
}

async function restoreRoomSession(page: Page): Promise<void> {
    await page.addInitScript((storedSession) => {
        window.localStorage.setItem(
            'auth.session',
            JSON.stringify({
                ...storedSession,
                expiresAtEpochMs: Date.now() + 60 * 60 * 1_000,
            }),
        );
        window.localStorage.setItem('relic.currentRoomId', 'room-1');
    }, session);
}

async function openListedRoomIfNeeded(page: Page): Promise<void> {
    const roomButton = page.getByRole('button', { name: 'Relic Hunters Expedition' }).first();
    const summary = page.getByLabel('Current turn summary');
    const deadline = Date.now() + 15_000;

    while (Date.now() < deadline) {
        const summaryText = await summary.textContent().catch(() => '');
        if (summaryText && !summaryText.includes('No Expedition')) {
            return;
        }
        if (await roomButton.count() > 0) {
            await roomButton.click({ force: true });
            return;
        }
        await page.waitForTimeout(250);
    }

    await expect(roomButton).toBeAttached({ timeout: 1_000 });
    await roomButton.click({ force: true });
}

async function captureSceneBaseline(page: Page, name: string): Promise<Buffer> {
    const options = {
        animations: 'disabled' as const,
        fullPage: false,
    };
    if (!WRITE_SCENE_BASELINES) {
        return await page.screenshot(options);
    }

    mkdirSync(SCENE_BASELINE_DIR, { recursive: true });
    return await page.screenshot({
        ...options,
        path: `${SCENE_BASELINE_DIR}/${name}.png`,
    });
}

async function mockBackend(page: Page, options: MockBackendOptions): Promise<void> {
    let rooms = [...(options.rooms ?? [])];
    let currentRelicSnapshot = options.relicSnapshot ?? relicSnapshotWithPlayers(1);
    let commandSnapshotIndex = 0;

    await page.route('http://127.0.0.1:5175/api/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        options.requests?.push(`${request.method()} ${path}`);

        if (path === '/api/config') {
            return json(route, {
                apiBaseUrl: 'http://127.0.0.1:5175',
                wsBaseUrl: 'ws://127.0.0.1:5175',
                endpoints: {
                    createWs: '/api/ws/:id',
                },
            });
        }

        if (path === '/api/auth/register') {
            return json(route, {
                clientId: session.clientId,
                username: session.username,
                displayName: 'Alice',
                registeredAtEpochMs: Date.now(),
            }, 201);
        }

        if (path === '/api/auth/login') {
            return json(route, session);
        }

        if (path === '/api/auth/ws-ticket') {
            return json(route, {
                ticket: 'test-ticket',
                sessionId: session.sessionId,
                expiresAtEpochMs: Date.now() + 60_000,
            });
        }

        if (path === '/api/webrtc/ice') {
            return json(route, {
                iceServers: [],
                expiresAtEpochMs: Date.now() + 60_000,
            });
        }

        if (path === '/api/relic/games/room-1') {
            return json(route, currentRelicSnapshot);
        }

        if (path === '/api/relic/games/room-1/reset') {
            currentRelicSnapshot = emptyRelicSnapshot();
            return json(route, currentRelicSnapshot);
        }

        if (path === '/api/relic/games/room-1/commands') {
            const commandBody = parseJsonBody(request.postData());
            options.commandBodies?.push(commandBody);
            currentRelicSnapshot = options.commandResponse?.(commandBody) ??
                options.commandSnapshots?.[commandSnapshotIndex] ??
                options.commandSnapshot ??
                relicSnapshotWithPlayers(1);
            commandSnapshotIndex += 1;
            return json(route, currentRelicSnapshot);
        }

        if (path.endsWith('/clients') && request.method() === 'GET') {
            return json(route, [clientSnapshot()]);
        }

        if (path.endsWith('/groups') && request.method() === 'POST') {
            const created = groupSnapshot({ onlineMemberCount: 1 });
            rooms = [created];
            return json(route, created, 201);
        }

        if (path.endsWith('/groups') && request.method() === 'GET') {
            return json(route, rooms);
        }

        if (path.includes('/groups/') && !path.endsWith('/groups')) {
            const room = rooms[0] ?? groupSnapshot({ onlineMemberCount: 1 });
            rooms = [room];
            return json(route, room);
        }

        if (path.includes('/clients/') && path.endsWith('/heartbeat')) {
            return json(route, clientSnapshot());
        }

        return json(route, {});
    });
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
    await route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
    });
}

function parseJsonBody(body: string | null): unknown {
    if (!body) {
        return undefined;
    }

    return JSON.parse(body);
}

function isCommandKind(body: unknown, kind: string): boolean {
    return typeof body === 'object' &&
        body !== null &&
        'kind' in body &&
        (body as { kind?: unknown }).kind === kind;
}

async function sceneHasVisiblePixels(page: Page): Promise<boolean> {
    return await page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('canvas.relic-scene');
        if (!canvas) {
            return false;
        }

        if (canvas.dataset.sceneReady === 'true') {
            return true;
        }

        const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
        if (!gl) {
            return false;
        }

        const width = gl.drawingBufferWidth;
        const height = gl.drawingBufferHeight;
        if (width <= 0 || height <= 0) {
            return false;
        }

        const pixels = new Uint8Array(4);
        const samples: readonly Readonly<[number, number]>[] = [
            [0.5, 0.5],
            [0.34, 0.42],
            [0.66, 0.42],
            [0.5, 0.28],
            [0.5, 0.72],
        ];
        for (const [xRatio, yRatio] of samples) {
            gl.readPixels(
                Math.min(width - 1, Math.max(0, Math.floor(width * xRatio))),
                Math.min(height - 1, Math.max(0, Math.floor(height * yRatio))),
                1,
                1,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                pixels,
            );
            if (pixels[3] > 0 && (pixels[0] > 4 || pixels[1] > 4 || pixels[2] > 4)) {
                return true;
            }
        }

        return false;
    });
}

async function sceneCanvasMetrics(page: Page): Promise<Readonly<{
    ready: boolean;
    cssWidth: number;
    cssHeight: number;
    drawingBufferWidth: number;
    drawingBufferHeight: number;
    devicePixelRatio: number;
    highDpi: boolean;
    hasRenderedFrame: boolean;
    averageLuma: number;
    cameraMode?: string;
    lightingPreset?: string;
    assetPipeline?: string;
    meshCount: number;
    activeMeshCount: number;
    materialCount: number;
    particleSystemCount: number;
    activeParticleSystemCount: number;
    activeRoomLightCount: number;
    staticBatchCount: number;
    batchedMeshCount: number;
    activeEffectCount: number;
    effectMeshCount: number;
    drawCalls?: number;
    fps?: number;
    readyMs: number;
}>> {
    return await page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('canvas.relic-scene');
        if (!canvas) {
            return {
                ready: false,
                cssWidth: 0,
                cssHeight: 0,
                drawingBufferWidth: 0,
                drawingBufferHeight: 0,
                devicePixelRatio: window.devicePixelRatio,
                highDpi: false,
                hasRenderedFrame: false,
                averageLuma: 0,
                cameraMode: undefined,
                lightingPreset: undefined,
                assetPipeline: undefined,
                meshCount: 0,
                activeMeshCount: 0,
                materialCount: 0,
                particleSystemCount: 0,
                activeParticleSystemCount: 0,
                activeRoomLightCount: 0,
                staticBatchCount: 0,
                batchedMeshCount: 0,
                activeEffectCount: 0,
                effectMeshCount: 0,
                drawCalls: undefined,
                fps: undefined,
                readyMs: 0,
            };
        }

        const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
        const box = canvas.getBoundingClientRect();
        if (!gl || box.width <= 0 || box.height <= 0) {
            return {
                ready: false,
                cssWidth: box.width,
                cssHeight: box.height,
                drawingBufferWidth: 0,
                drawingBufferHeight: 0,
                devicePixelRatio: window.devicePixelRatio,
                highDpi: false,
                hasRenderedFrame: false,
                averageLuma: 0,
                cameraMode: canvas.dataset.cameraMode,
                lightingPreset: canvas.dataset.lightingPreset,
                assetPipeline: canvas.dataset.assetPipeline,
                meshCount: numberDataset(canvas.dataset.sceneMeshCount),
                activeMeshCount: numberDataset(canvas.dataset.sceneActiveMeshCount),
                materialCount: numberDataset(canvas.dataset.sceneMaterialCount),
                particleSystemCount: numberDataset(canvas.dataset.sceneParticleSystemCount),
                activeParticleSystemCount: numberDataset(canvas.dataset.sceneActiveParticleSystemCount),
                activeRoomLightCount: numberDataset(canvas.dataset.sceneActiveRoomLightCount),
                staticBatchCount: numberDataset(canvas.dataset.sceneStaticBatchCount),
                batchedMeshCount: numberDataset(canvas.dataset.sceneBatchedMeshCount),
                activeEffectCount: numberDataset(canvas.dataset.sceneActiveEffectCount),
                effectMeshCount: numberDataset(canvas.dataset.sceneEffectMeshCount),
                drawCalls: optionalNumberDataset(canvas.dataset.sceneDrawCalls),
                fps: optionalNumberDataset(canvas.dataset.sceneFps),
                readyMs: numberDataset(canvas.dataset.sceneReadyMs),
            };
        }

        const width = gl.drawingBufferWidth;
        const height = gl.drawingBufferHeight;
        const pixels = new Uint8Array(4);
        const samples: readonly Readonly<[number, number]>[] = [
            [0.50, 0.50],
            [0.30, 0.38],
            [0.70, 0.38],
            [0.40, 0.62],
            [0.60, 0.62],
            [0.50, 0.24],
            [0.50, 0.76],
        ];
        let visibleSamples = 0;
        let lumaTotal = 0;
        for (const [xRatio, yRatio] of samples) {
            gl.readPixels(
                Math.min(width - 1, Math.max(0, Math.floor(width * xRatio))),
                Math.min(height - 1, Math.max(0, Math.floor(height * yRatio))),
                1,
                1,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                pixels,
            );
            const luma = pixels[0] * 0.2126 + pixels[1] * 0.7152 + pixels[2] * 0.0722;
            lumaTotal += luma;
            if (pixels[3] > 0 && luma > 6) {
                visibleSamples += 1;
            }
        }

        const expectedScale = Math.min(window.devicePixelRatio || 1, 2);
        return {
            ready: canvas.dataset.sceneReady === 'true' || visibleSamples > 0,
            cssWidth: box.width,
            cssHeight: box.height,
            drawingBufferWidth: width,
            drawingBufferHeight: height,
            devicePixelRatio: window.devicePixelRatio,
            highDpi: width >= box.width * expectedScale - 2 &&
                height >= box.height * expectedScale - 2,
            hasRenderedFrame: canvas.dataset.sceneReady === 'true' || visibleSamples >= 2,
            averageLuma: lumaTotal / samples.length,
            cameraMode: canvas.dataset.cameraMode,
            lightingPreset: canvas.dataset.lightingPreset,
            assetPipeline: canvas.dataset.assetPipeline,
            meshCount: numberDataset(canvas.dataset.sceneMeshCount),
            activeMeshCount: numberDataset(canvas.dataset.sceneActiveMeshCount),
            materialCount: numberDataset(canvas.dataset.sceneMaterialCount),
            particleSystemCount: numberDataset(canvas.dataset.sceneParticleSystemCount),
            activeParticleSystemCount: numberDataset(canvas.dataset.sceneActiveParticleSystemCount),
            activeRoomLightCount: numberDataset(canvas.dataset.sceneActiveRoomLightCount),
            staticBatchCount: numberDataset(canvas.dataset.sceneStaticBatchCount),
            batchedMeshCount: numberDataset(canvas.dataset.sceneBatchedMeshCount),
            activeEffectCount: numberDataset(canvas.dataset.sceneActiveEffectCount),
            effectMeshCount: numberDataset(canvas.dataset.sceneEffectMeshCount),
            drawCalls: optionalNumberDataset(canvas.dataset.sceneDrawCalls),
            fps: optionalNumberDataset(canvas.dataset.sceneFps),
            readyMs: numberDataset(canvas.dataset.sceneReadyMs),
        };

        function numberDataset(value: string | undefined): number {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : 0;
        }

        function optionalNumberDataset(value: string | undefined): number | undefined {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : undefined;
        }
    });
}

function clientSnapshot(): MockClientSnapshot {
    const now = Date.now();
    return {
        principal: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            principalId: session.clientId,
            username: session.username,
            displayName: 'Alice',
            status: 'active',
            roles: [],
            metadata: {},
            profileVersion: 1,
            presenceVersion: 1,
            created: { atEpochMs: now },
            updated: { atEpochMs: now },
        },
        instances: [
            {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                principalId: session.clientId,
                clientInstanceId: session.clientId,
                status: 'active',
                platform: 'web',
                capabilities: [],
                registered: { atEpochMs: now },
                updated: { atEpochMs: now },
            },
        ],
        activeSessions: [
            {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                principalId: session.clientId,
                clientInstanceId: session.clientId,
                sessionId: session.sessionId,
                status: 'active',
                presenceState: 'online',
                transport: 'ws',
                authenticatedAtEpochMs: now,
                connectedAtEpochMs: now,
                lastHeartbeatAtEpochMs: now,
                expiresAtEpochMs: now + 60_000,
            },
        ],
        isOnline: true,
        activeSessionCount: 1,
        lastSeenAtEpochMs: now,
    };
}

function groupSnapshot(
    options: Readonly<{ onlineMemberCount: number }>,
): MockGroupSnapshot {
    const now = Date.now();
    return {
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'room-1',
            slug: 'relic-hunters-expedition',
            displayName: 'Relic Hunters Expedition',
            kind: 'room',
            status: 'active',
            joinMode: 'invite-only',
            metadata: {},
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 1,
            created: { atEpochMs: now, byPrincipalId: session.clientId },
            updated: { atEpochMs: now, byPrincipalId: session.clientId },
        },
        members: [
            {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'room-1',
                principalId: session.clientId,
                role: 'owner',
                status: 'active',
                joined: { atEpochMs: now },
                updated: { atEpochMs: now },
            },
        ],
        activeSessions: options.onlineMemberCount > 0
            ? [
                {
                    applicationId: 'rallar-server',
                    workspaceId: 'default',
                    groupId: 'room-1',
                    sessionId: session.sessionId,
                    principalId: session.clientId,
                    connectedAtEpochMs: now,
                    lastHeartbeatAtEpochMs: now,
                    expiresAtEpochMs: now + 60_000,
                },
            ]
            : [],
        memberCount: 1,
        onlineMemberCount: options.onlineMemberCount,
    };
}

function relicSnapshotWithPlayers(
    playerCount: 1 | 2 | 4,
    phase: RelicPhase = 'lobby',
    options: Readonly<{
        carryRelic?: boolean;
        includeStorage?: boolean;
        includeExit?: boolean;
        playerRoomId?: string;
        playerRooms?: Readonly<Record<string, string>>;
        playerRelicIds?: Readonly<Record<string, readonly string[]>>;
        playerScores?: Readonly<Record<string, number>>;
        roomInvestigations?: readonly Record<string, unknown>[];
        events?: readonly Record<string, unknown>[];
        submittedPlayerIds?: readonly string[];
        includeFullMap?: boolean;
        round?: number;
        roundStartedAtEpochMs?: number;
        roundTimeLimitMs?: number;
    }> = {},
): RelicSnapshot {
    const playerSpecs = [
        ['alice-session', 'Alice', 'kael-ironstride'],
        ['bob-session', 'Bob', 'nyra-vale'],
        ['cara-session', 'Cara', 'oryn-starcoil'],
        ['dain-session', 'Dain', 'vessa-thornlock'],
    ] as const;
    const players = playerSpecs.slice(0, playerCount).map(([playerId, username, characterId]) => {
        const relicIds = options.playerRelicIds?.[playerId] ??
            (options.carryRelic && playerId === 'alice-session' ? ['golden-idol'] : []);
        return {
            playerId,
            username,
            characterId,
            roomId: options.playerRooms?.[playerId] ?? options.playerRoomId ?? 'entrance',
            health: 3,
            escaped: false,
            defeated: false,
            score: options.playerScores?.[playerId] ?? 0,
            relicIds,
        };
    });
    const carriedRelics = [
        ...(options.carryRelic
            ? [
                {
                    id: 'golden-idol',
                    name: 'Golden Idol',
                    value: 5,
                    roomId: 'treasure',
                    foundBy: 'alice-session',
                    carriedBy: 'alice-session',
                },
            ]
            : []),
        ...Object.entries(options.playerRelicIds ?? {}).flatMap(([playerId, relicIds]) =>
            relicIds.map((relicId, index) => ({
                id: relicId,
                name: relicId === 'sun-disk' ? 'Sun Disk' : `Relic ${index + 1}`,
                value: relicId === 'sun-disk' ? 6 : 4,
                roomId: options.playerRooms?.[playerId] ?? options.playerRoomId ?? 'entrance',
                foundBy: playerId,
                carriedBy: playerId,
            }))
        ),
    ];

    const map = options.includeFullMap
        ? [
            {
                id: 'entrance',
                name: 'Entrance',
                kind: 'entrance',
                x: 0,
                z: -6,
                neighbors: ['hallway', 'storage'],
            },
            {
                id: 'hallway',
                name: 'Hallway',
                kind: 'hallway',
                x: 0,
                z: -3,
                neighbors: ['entrance', 'shrine', 'monster'],
            },
            {
                id: 'storage',
                name: 'Storage',
                kind: 'storage',
                x: -4,
                z: -3,
                neighbors: ['entrance', 'trap'],
            },
            {
                id: 'trap',
                name: 'Trap Room',
                kind: 'trap',
                x: -4,
                z: 0,
                neighbors: ['storage', 'shrine'],
            },
            {
                id: 'shrine',
                name: 'Shrine',
                kind: 'shrine',
                x: 0,
                z: 0,
                neighbors: ['hallway', 'trap', 'treasure', 'exit'],
            },
            {
                id: 'monster',
                name: 'Monster',
                kind: 'monster',
                x: 4,
                z: -3,
                neighbors: ['hallway', 'treasure'],
            },
            {
                id: 'treasure',
                name: 'Treasure',
                kind: 'treasure',
                x: 4,
                z: 0,
                neighbors: ['monster', 'shrine'],
            },
            {
                id: 'exit',
                name: 'Exit',
                kind: 'exit',
                x: 0,
                z: 3,
                neighbors: ['shrine'],
            },
        ]
        : [
            {
                id: 'entrance',
                name: 'Entrance',
                kind: 'entrance',
                x: 0,
                z: -6,
                neighbors: options.includeStorage ? ['hallway', 'storage'] : ['hallway'],
            },
            {
                id: 'hallway',
                name: 'Hallway',
                kind: 'hallway',
                x: 0,
                z: -3,
                neighbors: options.includeExit ? ['entrance', 'exit'] : ['entrance'],
            },
            ...(options.includeExit
                ? [
                    {
                        id: 'exit',
                        name: 'Exit',
                        kind: 'exit',
                        x: 0,
                        z: 0,
                        neighbors: ['hallway'],
                    },
                ]
                : []),
            ...(options.includeStorage
                ? [
                    {
                        id: 'storage',
                        name: 'Storage',
                        kind: 'storage',
                        x: -4,
                        z: -3,
                        neighbors: ['entrance', 'trap'],
                    },
                    {
                        id: 'trap',
                        name: 'Trap Room',
                        kind: 'trap',
                        x: -4,
                        z: 0,
                        neighbors: ['storage'],
                    },
                ]
                : []),
        ];

    return {
        protocolVersion: 1,
        gameId: 'room-1',
        roomId: 'room-1',
        phase,
        round: options.round ?? 1,
        maxRounds: 10,
        updatedAtEpochMs: Date.now(),
        roundTimeLimitMs: options.roundTimeLimitMs ?? 180_000,
        roundStartedAtEpochMs: options.roundStartedAtEpochMs,
        map,
        relics: carriedRelics,
        roomInvestigations: options.roomInvestigations ?? [],
        players,
        submittedPlayerIds: options.submittedPlayerIds ?? [],
        events: options.events ?? [],
        winnerIds: [],
    };
}

function emptyRelicSnapshot(): RelicSnapshot {
    return {
        ...relicSnapshotWithPlayers(1),
        players: [],
        submittedPlayerIds: [],
        events: [],
    };
}

function resolvedSearchSnapshot(): RelicSnapshot {
    const now = Date.now();
    return relicSnapshotWithPlayers(1, 'planning', {
        round: 2,
        events: [
            {
                id: 'turn-1-reveal',
                round: 1,
                type: 'action_revealed',
                message: 'Round 1 actions are revealed.',
                tone: 'mystery',
                createdAtEpochMs: now,
            },
            {
                id: 'turn-1-search',
                round: 1,
                type: 'player_searched',
                message: 'Alice searched the Entrance.',
                animationCue: {
                    type: 'search_altar',
                    playerId: 'alice-session',
                    roomId: 'entrance',
                    durationMs: 700,
                    intensity: 'low',
                },
                tone: 'mystery',
                createdAtEpochMs: now,
            },
            {
                id: 'turn-1-round-2',
                round: 1,
                type: 'round_started',
                message: 'Round 2 begins.',
                tone: 'mystery',
                createdAtEpochMs: now,
            },
        ],
    });
}

function resolvedStorageSearchSnapshot(): RelicSnapshot {
    const now = Date.now();
    return relicSnapshotWithPlayers(1, 'planning', {
        includeStorage: true,
        playerRoomId: 'storage',
        roomInvestigations: [
            {
                roomId: 'storage',
                searchedByPlayerId: 'alice-session',
                searchedByUsername: 'Alice',
                searchedAtRound: 1,
                searchedAtEpochMs: now,
                result: 'empty',
                summary: 'The crates held a torn supply map, but no relic.',
                hint: 'The supply marks point back toward the Entrance and onward through the Trap Room.',
                effect: 'map-fragment',
                revealedRoomId: 'trap',
            },
        ],
        events: [
            {
                id: 'event-reveal-1',
                round: 1,
                type: 'action_revealed',
                message: 'Round 1 actions are revealed.',
                animationCue: {
                    type: 'noise_pulse',
                    durationMs: 620,
                    intensity: 'low',
                },
                tone: 'mystery',
                createdAtEpochMs: now,
            },
            {
                id: 'event-search-1',
                round: 1,
                type: 'player_searched',
                message: 'Alice searched the crates and marked a false supply trail.',
                animationCue: {
                    type: 'search_altar',
                    playerId: 'alice-session',
                    roomId: 'storage',
                    durationMs: 700,
                    intensity: 'low',
                },
                tone: 'mystery',
                createdAtEpochMs: now,
            },
            {
                id: 'event-noise-1',
                round: 1,
                type: 'noise_pulse',
                message: 'The ruin hears 2 noise.',
                animationCue: {
                    type: 'noise_pulse',
                    durationMs: 900,
                    intensity: 'low',
                },
                tone: 'mystery',
                createdAtEpochMs: now,
            },
            {
                id: 'event-round-2',
                round: 1,
                type: 'round_started',
                message: 'Round 2 begins.',
                tone: 'mystery',
                createdAtEpochMs: now,
            },
        ],
        round: 2,
    });
}

function reviewStorageSearchSnapshot(): RelicSnapshot {
    const now = Date.now();
    return relicSnapshotWithPlayers(1, 'review', {
        includeStorage: true,
        playerRoomId: 'storage',
        roomInvestigations: [
            {
                roomId: 'storage',
                searchedByPlayerId: 'alice-session',
                searchedByUsername: 'Alice',
                searchedAtRound: 1,
                searchedAtEpochMs: now,
                result: 'empty',
                summary: 'The crates held a torn supply map, but no relic.',
                hint: 'The supply marks point back toward the Entrance and onward through the Trap Room.',
                effect: 'map-fragment',
                revealedRoomId: 'trap',
            },
        ],
        events: [
            {
                id: 'event-reveal-1',
                round: 1,
                type: 'action_revealed',
                message: 'Round 1 actions are revealed.',
                animationCue: {
                    type: 'noise_pulse',
                    durationMs: 620,
                    intensity: 'low',
                },
                tone: 'mystery',
                createdAtEpochMs: now,
            },
            {
                id: 'event-search-1',
                round: 1,
                type: 'player_searched',
                message: 'Alice searched the crates and marked a false supply trail.',
                animationCue: {
                    type: 'search_altar',
                    playerId: 'alice-session',
                    roomId: 'storage',
                    durationMs: 700,
                    intensity: 'low',
                },
                tone: 'mystery',
                createdAtEpochMs: now,
            },
            {
                id: 'event-noise-1',
                round: 1,
                type: 'noise_pulse',
                message: 'The ruin hears 2 noise.',
                animationCue: {
                    type: 'noise_pulse',
                    durationMs: 900,
                    intensity: 'low',
                },
                tone: 'mystery',
                createdAtEpochMs: now,
            },
        ],
        submittedPlayerIds: [],
    });
}

function continuedStoragePlanningSnapshot(): RelicSnapshot {
    const review = reviewStorageSearchSnapshot() as {
        events: readonly Record<string, unknown>[];
    } & Record<string, unknown>;
    return {
        ...review,
        phase: 'planning',
        round: 2,
        roundStartedAtEpochMs: Date.now(),
        events: [
            ...review.events,
            {
                id: 'event-round-2',
                round: 1,
                type: 'round_started',
                message: 'Round 2 begins.',
                tone: 'mystery',
                createdAtEpochMs: Date.now(),
            },
        ],
    };
}

function finishedRelicSnapshot(): RelicSnapshot {
    const now = Date.now();
    const base = relicSnapshotWithPlayers(2, 'planning', {
        carryRelic: true,
        includeExit: true,
        playerRoomId: 'exit',
        playerScores: {
            'alice-session': 5,
            'bob-session': 1,
        },
        events: [
            {
                id: 'turn-final-escape',
                round: 3,
                type: 'player_escaped',
                message: 'Alice escaped with the Golden Idol.',
                tone: 'success',
                createdAtEpochMs: now,
            },
            {
                id: 'turn-final-finished',
                round: 3,
                type: 'game_finished',
                message: 'The expedition is over.',
                tone: 'success',
                createdAtEpochMs: now,
            },
        ],
        round: 3,
    }) as {
        players: Array<Record<string, unknown>>;
        relics: Array<Record<string, unknown>>;
    } & Record<string, unknown>;

    return {
        ...base,
        phase: 'finished',
        winnerIds: ['alice-session'],
        submittedPlayerIds: [],
        players: base.players.map((player) =>
            player.playerId === 'alice-session'
                ? { ...player, escaped: true, score: 5, relicIds: [] }
                : player
        ),
        relics: base.relics.map((relic) =>
            relic.id === 'golden-idol'
                ? {
                    ...relic,
                    carriedBy: undefined,
                    escapedBy: 'alice-session',
                }
                : relic
        ),
    };
}

type MockClientSnapshot = Readonly<Record<string, unknown>>;
type MockGroupSnapshot = Readonly<Record<string, unknown>>;
type RelicSnapshot = Readonly<Record<string, unknown>>;
