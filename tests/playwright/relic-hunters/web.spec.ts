import {
    expect,
    test,
    type Page
} from '@playwright/test';
import type { Buffer } from 'node:buffer';
import { mkdirSync, writeFileSync } from 'node:fs';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { parseALControlMessage } from '@shared/al-contracts/al-control.ts';
import type { RelicCommand, RelicPublicSnapshot } from '../../../packages/relic-hunters/mod.ts';

import {
    createGroupSnapshot,
    initBrowserTestTransport,
    restoreAuthenticatedSession,
    session,
    startRelicBrowserBackend
} from './relic-browser-backend.ts';
import {
    createContinuedStoragePlanningSnapshot,
    createEmptyRelicSnapshot,
    createFinishedRelicSnapshot,
    createRelicSnapshotWithPlayers,
    createResolvedSearchSnapshot,
    createResolvedStorageSearchSnapshot,
    createReviewStorageSearchSnapshot
} from './relic-browser-snapshots.ts';
import {
    readSceneCanvasMetrics,
    readSceneVisibility,
    type SceneCanvasMetrics
} from './relic-scene-observations.ts';

interface SceneBaselineScenario {
    readonly name: string;
    readonly mode: 'opening' | 'room';
    readonly viewport: Readonly<{ width: number; height: number; }>;
    snapshot?: RelicPublicSnapshot;
    commandSnapshot?: RelicPublicSnapshot;
    onlineMemberCount?: number;
    expectedCameraMode?: string;
    expectedLightingPreset?: string;
    wait?(page: Page): Promise<void>;
}
interface SceneBaselineMetric extends SceneCanvasMetrics {
    readonly scenario: string;
}

const SCENE_BASELINE_DIR = 'apps/relic-hunters-v1/baseline/screenshots/scene-upgrades';
const WRITE_SCENE_BASELINES = process.env.RELIC_SCENE_BASELINE_WRITE === '1' ||
    process.env.RELIC_SCENE_BASELINE_WRITE === 'true';

test.describe('Relic Hunters web app', () => {
    test('renders a Babylon opening scene before authentication', async ({ page }) => {
        await initBrowserTestTransport(page);
        await startRelicBrowserBackend(page, { rooms: [] });

        await page.goto('/');

        const canvas = page.locator('canvas.relic-scene');
        await expect(canvas).toBeVisible();
        await expect(page.locator('.relic-scene-fallback')).toHaveCount(0);
        await expect.poll(() => readSceneVisibility(page)).toBe(true);
        await expect(page.getByRole('button', { name: 'Login' })).toBeVisible();
    });

    test('rejects hidden or contextless canvases despite stale scene-ready metadata', async ({ page }) => {
        await page.setContent('<canvas class="relic-scene" data-scene-ready="true" width="300" height="150"></canvas>');
        await page.locator('canvas').evaluate((canvas: HTMLCanvasElement) => {
            canvas.getContext('webgl2');
        });
        expect(await readSceneCanvasMetrics(page)).toMatchObject({
            ready: true,
            highDpi: true,
            hasRenderedFrame: true
        });

        await page.locator('canvas').evaluate((canvas: HTMLCanvasElement) => {
            canvas.style.width = '0px';
            canvas.style.height = '0px';
        });
        expect(await readSceneCanvasMetrics(page)).toMatchObject({
            ready: false,
            highDpi: false,
            hasRenderedFrame: false
        });

        await page.setContent('<canvas class="relic-scene" data-scene-ready="true" width="300" height="150"></canvas>');
        await page.locator('canvas').evaluate((canvas: HTMLCanvasElement) => {
            canvas.getContext('2d');
        });
        expect(await readSceneCanvasMetrics(page)).toMatchObject({
            ready: false,
            highDpi: false,
            hasRenderedFrame: false
        });
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
                expectedLightingPreset: 'day'
            },
            {
                name: 'lobby-desktop',
                mode: 'room',
                viewport: { width: 1280, height: 720 },
                snapshot: createRelicSnapshotWithPlayers(1, 'lobby'),
                expectedLightingPreset: 'neon-dystopia',
                wait: async (page) => {
                    await expect(page.getByText('Keeper: Alice')).toBeVisible();
                    await expect(page.getByRole('button', { name: /^Start$/ })).toBeVisible();
                }
            },
            {
                name: 'planning-desktop',
                mode: 'room',
                viewport: { width: 1280, height: 720 },
                snapshot: createRelicSnapshotWithPlayers(1, 'planning', { includeStorage: true }),
                expectedCameraMode: 'avatar',
                expectedLightingPreset: 'neon-dystopia',
                wait: async (page) => {
                    await expect(page.getByLabel('Current turn summary')).toContainText('Choose one plan');
                    await expect(page.getByRole('button', { name: 'Submit Plan' })).toBeVisible();
                }
            },
            {
                name: 'planning-mobile',
                mode: 'room',
                viewport: { width: 390, height: 844 },
                snapshot: createRelicSnapshotWithPlayers(1, 'planning', { includeStorage: true }),
                expectedCameraMode: 'avatar',
                expectedLightingPreset: 'neon-dystopia',
                wait: async (page) => {
                    await expect(page.getByLabel('Current turn summary')).toContainText('Choose one plan');
                    await expect(page.getByRole('button', { name: 'Submit Plan' })).toBeVisible();
                }
            },
            {
                name: 'waiting-locked-desktop',
                mode: 'room',
                viewport: { width: 1280, height: 720 },
                snapshot: createRelicSnapshotWithPlayers(2, 'planning', {
                    submittedPlayerIds: ['alice-session']
                }),
                onlineMemberCount: 2,
                expectedCameraMode: 'avatar',
                expectedLightingPreset: 'neon-dystopia',
                wait: async (page) => {
                    await expect(page.getByLabel('Current turn summary')).toContainText('Plan Locked');
                    await expect(page.getByLabel('Round plan')).toContainText('1 hunter still choosing');
                }
            },
            {
                name: 'split-party-identities-desktop',
                mode: 'room',
                viewport: { width: 1280, height: 720 },
                snapshot: createRelicSnapshotWithPlayers(4, 'planning', {
                    includeFullMap: true,
                    playerRooms: {
                        'alice-session': 'entrance',
                        'bob-session': 'shrine',
                        'cara-session': 'monster',
                        'dain-session': 'exit'
                    },
                    playerRelicIds: {
                        'dain-session': ['sun-disk']
                    },
                    submittedPlayerIds: ['alice-session', 'cara-session']
                }),
                onlineMemberCount: 4,
                expectedCameraMode: 'avatar',
                expectedLightingPreset: 'neon-dystopia',
                wait: async (page) => {
                    await expect(page.getByLabel('Current turn summary')).toContainText('Plan Locked');
                    await expect(page.getByLabel('Castle room map')).toContainText('Shrine');
                    await expect(page.getByLabel('Castle room map')).toContainText('Monster');
                    await expect(page.getByLabel('Castle room map')).toContainText('Treasure');
                    await expect(page.getByLabel('Room occupants')).toContainText('1 hunter here / 3 elsewhere');
                }
            },
            {
                name: 'resolved-timeline-desktop',
                mode: 'room',
                viewport: { width: 1280, height: 720 },
                snapshot: createRelicSnapshotWithPlayers(1, 'planning', {
                    includeStorage: true,
                    playerRoomId: 'storage'
                }),
                commandSnapshot: createResolvedStorageSearchSnapshot(),
                expectedCameraMode: 'avatar',
                expectedLightingPreset: 'neon-dystopia',
                wait: async (page) => {
                    await expect(page.getByLabel('Current turn summary')).toContainText(
                        'Choose one plan',
                        { timeout: 15_000 }
                    );
                    await expect(page.getByRole('button', { name: 'Submit Plan' })).toBeEnabled();
                    await page.getByRole('button', { name: 'Submit Plan' }).click();
                    await expect(page.getByLabel('Turn timeline')).toContainText(
                        'Alice searched the crates and marked a false supply trail.',
                        { timeout: 15_000 }
                    );
                }
            },
            {
                name: 'finished-desktop',
                mode: 'room',
                viewport: { width: 1280, height: 720 },
                snapshot: createFinishedRelicSnapshot(),
                expectedLightingPreset: 'neon-dystopia',
                wait: async (page) => {
                    await expect(page.getByText('The Heart Relic has chosen')).toBeVisible();
                    await expect(page.getByText('Final score: 5')).toBeVisible();
                }
            }
        ];

        for (const scenario of scenarios) {
            const context = await browser.newContext({
                viewport: scenario.viewport,
                deviceScaleFactor: 2
            });
            const page = await context.newPage();
            try {
                await initBrowserTestTransport(page);
                if (scenario.mode === 'room') {
                    await restoreAuthenticatedSession(page);
                }
                await startRelicBrowserBackend(page, {
                    rooms: scenario.mode === 'room'
                        ? [createGroupSnapshot({ onlineMemberCount: scenario.onlineMemberCount ?? 1 })]
                        : [],
                    relicSnapshot: scenario.snapshot ?? createEmptyRelicSnapshot(),
                    commandSnapshot: scenario.commandSnapshot
                });

                await page.goto('http://127.0.0.1:5175/');
                if (scenario.mode === 'room') {
                    await page.getByRole('button', { name: 'Relic Hunters Expedition' }).first().click();
                    await scenario.wait?.(page);
                }
                else {
                    await expect(page.getByRole('button', { name: 'Login' })).toBeVisible();
                }

                await expect.poll(() => readSceneCanvasMetrics(page), {
                    message: `${scenario.name} canvas should render visible high-DPI pixels`,
                    timeout: 20_000
                }).toMatchObject({
                    ready: true,
                    devicePixelRatio: 2,
                    highDpi: true,
                    hasRenderedFrame: true,
                    ...(scenario.expectedCameraMode ? { cameraMode: scenario.expectedCameraMode } : {}),
                    ...(scenario.expectedLightingPreset
                        ? { lightingPreset: scenario.expectedLightingPreset }
                        : {}),
                    assetPipeline: 'procedural'
                });

                const metrics = await readSceneCanvasMetrics(page);
                expect(metrics.meshCount).toBeGreaterThan(0);
                expect(metrics.materialCount).toBeGreaterThan(0);
                if (scenario.expectedCameraMode) {
                    expect(metrics.activeMeshCount).toBeGreaterThan(0);
                    expect(metrics.readyMs).toBeGreaterThan(0);
                }
                baselineMetrics.push({ scenario: scenario.name, ...metrics });

                const screenshot = await captureSceneBaseline(page, scenario.name);
                expect(screenshot.byteLength).toBeGreaterThan(10_000);
            }
            finally {
                await context.close();
            }
        }

        if (WRITE_SCENE_BASELINES) {
            mkdirSync(SCENE_BASELINE_DIR, { recursive: true });
            writeFileSync(
                `${SCENE_BASELINE_DIR}/scene-upgrade-metrics.json`,
                `${JSON.stringify(baselineMetrics, null, 2)}\n`
            );
        }
    });

    test('registers a player and shows the connected lobby controls', async ({ page }) => {
        await initBrowserTestTransport(page);
        await startRelicBrowserBackend(page, { rooms: [] });

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
        await initBrowserTestTransport(page);
        await startRelicBrowserBackend(page, {
            rooms: [createGroupSnapshot({ onlineMemberCount: 1 })],
            relicSnapshot: createEmptyRelicSnapshot()
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
        const room = createGroupSnapshot({ onlineMemberCount: 1 });
        await page.setViewportSize({ width: 1920, height: 1080 });
        await initBrowserTestTransport(page);
        await startRelicBrowserBackend(page, {
            rooms: [room],
            relicSnapshot: createRelicSnapshotWithPlayers(1, 'planning')
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
                lastChildBottom: lastChildBox?.bottom ?? panelBox.bottom
            };
        });
        expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
        expect(scrollMetrics.scrollTop).toBeGreaterThan(0);
        expect(scrollMetrics.lastChildBottom).toBeLessThanOrEqual(scrollMetrics.panelBottom + 1);
    });

    test('joins a room and prompts when expedition players no longer match online party', async ({ page }) => {
        const room = createGroupSnapshot({ onlineMemberCount: 1 });
        await initBrowserTestTransport(page);
        await startRelicBrowserBackend(page, {
            rooms: [room],
            relicSnapshot: createRelicSnapshotWithPlayers(2)
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
        const room = createGroupSnapshot({ onlineMemberCount: 1 });
        await initBrowserTestTransport(page);
        await startRelicBrowserBackend(page, {
            rooms: [room],
            relicSnapshot: createRelicSnapshotWithPlayers(2)
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
        const room = createGroupSnapshot({ onlineMemberCount: 1 });
        const requests: string[] = [];
        await initBrowserTestTransport(page);
        await startRelicBrowserBackend(page, {
            rooms: [room],
            relicSnapshot: createRelicSnapshotWithPlayers(2),
            requests
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
        expect(requests.some((request) => request.startsWith('POST /api/relic/games/room-1/reset/requests/'))).toBe(
            false
        );
    });

    test('shows lobby membership and start blockers when online members have not joined', async ({ page }) => {
        const room = createGroupSnapshot({ onlineMemberCount: 2 });
        await initBrowserTestTransport(page);
        await startRelicBrowserBackend(page, {
            rooms: [room],
            relicSnapshot: createRelicSnapshotWithPlayers(1)
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

    test('sends request-scoped HTTP commands from the browser UI before a WS server is known', async ({ page }) => {
        const room = createGroupSnapshot({ onlineMemberCount: 1 });
        const commandBodies: RelicCommand[] = [];
        const requests: string[] = [];
        await initBrowserTestTransport(page);
        await startRelicBrowserBackend(page, {
            rooms: [room],
            relicSnapshot: createEmptyRelicSnapshot(),
            commandBodies,
            requests,
            httpCommands: true
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

        const commandRequests = requests.filter((request) =>
            request.startsWith('POST /api/relic/games/room-1/commands/')
        );
        expect(commandRequests).toHaveLength(2);
        for (const request of commandRequests) {
            expect(request).toMatch(
                /^POST \/api\/relic\/games\/room-1\/commands\/requests\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
            );
        }
        expect(new Set(commandRequests).size).toBe(2);
        expect(commandBodies).toHaveLength(2);
        expect(commandBodies[0]).toMatchObject({
            protocolVersion: 1,
            kind: 'join-expedition',
            gameId: 'room-1',
            username: 'alice',
            characterId: 'kael-ironstride'
        });
        expect(commandBodies[1]).toMatchObject({
            protocolVersion: 1,
            kind: 'start-expedition',
            gameId: 'room-1',
            username: 'alice'
        });
        await expect(page.getByText('Keeper: Alice')).toBeVisible();
    });

    test('can force-resolve a timed-out round from the browser UI', async ({ page }) => {
        test.setTimeout(60_000);
        const room = createGroupSnapshot({ onlineMemberCount: 2 });
        const commandBodies: RelicCommand[] = [];
        await initBrowserTestTransport(page);
        await startRelicBrowserBackend(page, {
            rooms: [room],
            relicSnapshot: createRelicSnapshotWithPlayers(2, 'planning', {
                submittedPlayerIds: ['alice-session'],
                roundStartedAtEpochMs: Date.now() - 90_000,
                roundTimeLimitMs: 60_000
            }),
            commandBodies,
            commandSnapshot: createResolvedSearchSnapshot()
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

        await expect.poll(() => commandBodies.length).toBe(1);
        expect(commandBodies[0]).toMatchObject({
            protocolVersion: 1,
            kind: 'force-resolve-round',
            gameId: 'room-1',
            username: 'alice'
        });
    });

    test('creates a room and completes the first playable turn through the browser UI', async ({ page }) => {
        test.setTimeout(60_000);
        const commandBodies: RelicCommand[] = [];
        const receivedFrames: ALMessage[] = [];
        await initBrowserTestTransport(page);
        await startRelicBrowserBackend(page, {
            rooms: [],
            relicSnapshot: createEmptyRelicSnapshot(),
            commandBodies,
            receivedFrames,
            commandResponse: (body) => {
                const kind = body.kind;
                if (kind === 'join-expedition') {
                    return createRelicSnapshotWithPlayers(1);
                }
                if (kind === 'start-expedition') {
                    return createRelicSnapshotWithPlayers(1, 'planning');
                }
                if (kind === 'submit-action') {
                    return createResolvedSearchSnapshot();
                }
                return createRelicSnapshotWithPlayers(1);
            }
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
        expect(commandBodies.at(-1)).toMatchObject({ kind: 'start-expedition' });

        await expect(page.getByLabel('Current turn summary')).toContainText('Choose one plan', { timeout: 15_000 });
        await page.getByRole('button', { name: 'Submit Plan' }).click();

        await expect(page.getByLabel('Current turn summary')).toContainText('Choose one plan', { timeout: 15_000 });
        const timeline = page.getByLabel('Turn timeline');
        await expect(timeline).toContainText('Reveal', { timeout: 20_000 });
        await expect(timeline).toContainText('Your Action', { timeout: 20_000 });
        await expect(timeline).toContainText('Result', { timeout: 20_000 });
        await expect(timeline).toContainText('Alice searched the Entrance.', { timeout: 20_000 });
        expect(commandBodies.map((body) => body.kind)).toEqual([
            'join-expedition',
            'start-expedition',
            'submit-action'
        ]);
        for (const frame of receivedFrames.filter((frame) => frame.payload.typeId === 'relic.command.v1')) {
            expect(frame.targets).toEqual({
                mode: 'unicast',
                toPeerId: 'default-qbox-server',
                groupRef: { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'room-1' }
            });
        }
        // Receiver acknowledgements prove the browser accepted each emitted snapshot at the owned WS port.
        await expect.poll(() =>
            receivedFrames.filter((frame) => {
                const control = parseALControlMessage(frame);
                return control?.type === 'ack' && control.payload.toPeerId === 'default-qbox-server';
            }).length
        ).toBe(3);
    });

    test('renders the neon dystopian canvas and switches camera modes', async ({ page }) => {
        test.setTimeout(60_000);
        const room = createGroupSnapshot({ onlineMemberCount: 1 });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await initBrowserTestTransport(page);
        await startRelicBrowserBackend(page, {
            rooms: [room],
            relicSnapshot: createRelicSnapshotWithPlayers(1, 'planning')
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
        await expect.poll(() => readSceneVisibility(page)).toBe(true);
        await expect.poll(() => canvas.getAttribute('data-scene-runtime')).toBe(
            'next'
        );
        await expect.poll(() => canvas.getAttribute('data-scene-visual-theme')).toBe(
            'neon-dystopian'
        );
        await expect.poll(async () => (await readSceneCanvasMetrics(page)).activeRoomLightCount)
            .toBeGreaterThan(0);
        await expect.poll(async () => (await readSceneCanvasMetrics(page)).meshCount)
            .toBeGreaterThan(60);
        await expect.poll(async () => (await readSceneCanvasMetrics(page)).materialCount)
            .toBeGreaterThan(8);
        await expect.poll(async () => (await readSceneCanvasMetrics(page)).lightingPreset)
            .toBe('neon-dystopia');
        await expect.poll(async () => (await readSceneCanvasMetrics(page)).cameraMode)
            .toBe('avatar');
        await expect.poll(() => canvas.getAttribute('data-rallar-motion-lane')).toBe(
            'realtime'
        );

        await page.getByRole('button', { name: 'First-person view' }).click();
        await expect.poll(async () => (await readSceneCanvasMetrics(page)).cameraMode)
            .toBe('first-person');
        await page.getByRole('button', { name: 'Overview view' }).click();
        await expect.poll(async () => (await readSceneCanvasMetrics(page)).cameraMode)
            .toBe('overview');
        await page.getByRole('button', { name: 'Fly over rooms' }).click();
        await expect.poll(async () => (await readSceneCanvasMetrics(page)).cameraMode)
            .toBe('flyover');
        await expect.poll(async () => (await readSceneCanvasMetrics(page)).cameraMode, { timeout: 4_000 })
            .toBe('overview');
        await page.getByRole('button', { name: 'Avatar view' }).click();
        await expect.poll(async () => (await readSceneCanvasMetrics(page)).cameraMode)
            .toBe('avatar');

        const box = await canvas.boundingBox();
        expect(box).not.toBeNull();
        if (box) {
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.down();
            await page.mouse.move(box.x + box.width / 2 + 48, box.y + box.height / 2 + 24);
            await page.mouse.up();
            await page.keyboard.down('Shift');
            await page.keyboard.press('KeyW');
            await page.keyboard.up('Shift');
        }

        await expect(page.getByRole('button', { name: 'Atmosphere' }).first()).toBeVisible();
    });

    test('room selection primes a move plan without submitting it', async ({ page }) => {
        test.setTimeout(60_000);
        const room = createGroupSnapshot({ onlineMemberCount: 1 });
        const commandBodies: RelicCommand[] = [];
        await initBrowserTestTransport(page);
        await startRelicBrowserBackend(page, {
            rooms: [room],
            relicSnapshot: createRelicSnapshotWithPlayers(1, 'planning'),
            commandBodies
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
        await expect.poll(() => readSceneVisibility(page)).toBe(true);

        await page
            .getByLabel('Castle room map')
            .getByRole('button', { name: 'Hallway' })
            .click();
        await page.getByRole('button', { name: 'Prime Move → Hallway' }).click();

        await expect(page.getByText('Step into an adjacent room')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Submit Plan' })).toBeEnabled();
        expect(commandBodies).toHaveLength(0);
    });

    test('scene objective panel primes the recommended room action', async ({ page }) => {
        test.setTimeout(60_000);
        const room = createGroupSnapshot({ onlineMemberCount: 1 });
        const commandBodies: RelicCommand[] = [];
        await initBrowserTestTransport(page);
        await startRelicBrowserBackend(page, {
            rooms: [room],
            relicSnapshot: createRelicSnapshotWithPlayers(1, 'planning'),
            commandBodies
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
        const room = createGroupSnapshot({ onlineMemberCount: 1 });
        const commandBodies: RelicCommand[] = [];
        await initBrowserTestTransport(page);
        await startRelicBrowserBackend(page, {
            rooms: [room],
            relicSnapshot: createRelicSnapshotWithPlayers(1, 'planning', {
                carryRelic: true,
                includeExit: true,
                playerRoomId: 'exit'
            }),
            commandBodies
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
        const room = createGroupSnapshot({ onlineMemberCount: 4 });
        await initBrowserTestTransport(page);
        await startRelicBrowserBackend(page, {
            rooms: [room],
            relicSnapshot: createRelicSnapshotWithPlayers(4, 'planning', {
                includeStorage: true,
                playerRooms: {
                    'alice-session': 'storage',
                    'bob-session': 'storage',
                    'cara-session': 'trap',
                    'dain-session': 'hallway'
                },
                playerRelicIds: {
                    'bob-session': ['sun-disk']
                },
                playerScores: {
                    'bob-session': 6,
                    'cara-session': 1
                },
                submittedPlayerIds: ['alice-session', 'cara-session']
            })
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
        const room = createGroupSnapshot({ onlineMemberCount: 1 });
        await initBrowserTestTransport(page);
        await startRelicBrowserBackend(page, {
            rooms: [room],
            relicSnapshot: createRelicSnapshotWithPlayers(1, 'planning', {
                includeStorage: true,
                playerRoomId: 'storage'
            }),
            commandSnapshot: createRelicSnapshotWithPlayers(1, 'planning', {
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
                        revealedRoomId: 'trap'
                    }
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
                            intensity: 'low'
                        },
                        tone: 'mystery',
                        createdAtEpochMs: Date.now()
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
                            intensity: 'low'
                        },
                        tone: 'mystery',
                        createdAtEpochMs: Date.now()
                    },
                    {
                        id: 'event-noise-1',
                        round: 1,
                        type: 'noise_pulse',
                        message: 'The ruin hears 2 noise.',
                        animationCue: {
                            type: 'noise_pulse',
                            durationMs: 900,
                            intensity: 'low'
                        },
                        tone: 'mystery',
                        createdAtEpochMs: Date.now()
                    },
                    {
                        id: 'event-round-2',
                        round: 1,
                        type: 'round_started',
                        message: 'Round 2 begins.',
                        tone: 'mystery',
                        createdAtEpochMs: Date.now()
                    }
                ],
                round: 2
            })
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
        await expect(
            objective.getByText(
                'Next step: Move to Trap Room. The supply marks point back toward the Entrance and onward through the Trap Room.'
            )
        ).toBeVisible();
        await expect(page.getByLabel('Current turn summary')).toContainText('Choose one plan');
        const timeline = page.getByLabel('Turn timeline');
        await expect(timeline).toContainText('Your Action');
        await expect(timeline).toContainText('Castle Reaction');
        await expect(timeline).toContainText('Result');
        await expect(timeline).toContainText('Alice searched the crates and marked a false supply trail.');
        await expect(page.getByLabel('Discovered clue trails')).toContainText('Storage - Trap Room');
        await expect(page.getByLabel('Discovered clue trails')).toContainText(
            'The crates held a torn supply map, but no relic.'
        );
        await expect(page.getByLabel('Castle room map').getByRole('button', { name: 'Trap Room' })).toHaveClass(
            /clue-target/
        );
    });

    test('shows the review phase before the director continues to the next turn', async ({ page }) => {
        test.setTimeout(60_000);
        const commandBodies: RelicCommand[] = [];
        await initBrowserTestTransport(page);
        await startRelicBrowserBackend(page, {
            rooms: [createGroupSnapshot({ onlineMemberCount: 1 })],
            relicSnapshot: createRelicSnapshotWithPlayers(1, 'planning', {
                includeStorage: true,
                playerRoomId: 'storage'
            }),
            commandBodies,
            commandResponse: (body) => {
                if (isCommandKind(body, 'continue-review')) {
                    return createContinuedStoragePlanningSnapshot();
                }
                return createReviewStorageSearchSnapshot();
            }
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
            'Alice searched the crates and marked a false supply trail.'
        );

        await expect.poll(() => commandBodies.some((body) => isCommandKind(body, 'continue-review'))).toBe(true);
        await expect(page.getByLabel('Current turn summary')).toContainText('Choose one plan');
        await expect(page.getByRole('button', { name: 'Submit Plan' })).toBeEnabled();
    });

    test('Rallar browser bootstrap reads server config, state snapshots, and opens WebSocket', async ({ page }) => {
        const requests: string[] = [];
        const wsUrls: string[] = [];
        await initBrowserTestTransport(page);
        await startRelicBrowserBackend(page, { rooms: [], requests, wsUrls });

        await page.goto('/');
        await page.getByRole('button', { name: 'Register' }).click();
        await page.getByLabel('Username').fill('alice');
        await page.getByLabel('Display name').fill('Alice');
        await page.getByLabel('Password').fill('correct-horse');
        await page.getByRole('button', { name: 'Create Hunter' }).click();
        await expect(page.getByRole('button', { name: 'New Room' })).toBeVisible();

        expect(requests).toContain('GET /api/config');
        expect(
            requests.some((request) => request.startsWith('POST /api/auth/ws-ticket/requests/'))
        ).toBe(true);
        // The state reads follow the WS connect, which can settle after the lobby controls render.
        await expect.poll(() => requests).toContain('GET /api/state/apps/rallar-server/workspaces/default/clients');
        await expect.poll(() => requests).toContain('GET /api/state/apps/rallar-server/workspaces/default/groups');

        expect(wsUrls).toContain('ws://127.0.0.1:5175/api/ws/alice-session?ticket=test-ticket');
    });
});

async function captureSceneBaseline(page: Page, name: string): Promise<Buffer> {
    const options = {
        animations: 'disabled' as const,
        fullPage: false
    };
    if (!WRITE_SCENE_BASELINES) {
        return await page.screenshot(options);
    }

    mkdirSync(SCENE_BASELINE_DIR, { recursive: true });
    return await page.screenshot({
        ...options,
        path: `${SCENE_BASELINE_DIR}/${name}.png`
    });
}

function isCommandKind(body: RelicCommand, kind: RelicCommand['kind']): boolean {
    return body.kind === kind;
}
