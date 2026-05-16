import { expect, test, type Page, type Route } from '@playwright/test';

type MockBackendOptions = Readonly<{
    rooms?: readonly MockGroupSnapshot[];
    relicSnapshot?: RelicSnapshot;
    commandSnapshot?: RelicSnapshot;
    commandSnapshots?: readonly RelicSnapshot[];
    commandResponse?(body: unknown): RelicSnapshot;
    requests?: string[];
    commandBodies?: unknown[];
}>;

const session = {
    clientId: 'alice-client',
    accessToken: 'alice-token',
    username: 'alice',
    sessionId: 'alice-session',
    expiresAtEpochMs: Date.now() + 60_000,
};

test.describe('Relic Hunters web app', () => {
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
        const mobile = await page.screenshot({ animations: 'disabled' });
        expect(mobile.byteLength).toBeGreaterThan(10_000);
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
        await page.getByRole('button', { name: 'Relic Hunters Expedition' }).click();

        await expect(page.getByText('Party Changed')).toBeVisible();
        await expect(page.getByText('1/2 hunters are online')).toBeVisible();
        await expect(page.getByText(/Offline joined hunters can still block round resolution/)).toBeVisible();
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
        await page.getByRole('button', { name: 'Relic Hunters Expedition' }).click();
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
        await expect(movePrompt).toBeVisible();
        await movePrompt.click();
        await page.keyboard.up('w');

        await expect(page.getByText('Step into an adjacent room')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Submit Plan' })).toBeEnabled();
        expect(commandBodies).toHaveLength(0);
    });

    test('scene objective panel primes the recommended room action', async ({ page }) => {
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

        await expect(page.getByText('Step into an adjacent room')).toBeVisible();
        await expect(objective.getByText('Submit the plan to commit this turn-based move.')).toBeVisible();
        expect(commandBodies).toHaveLength(0);
    });

    test('scene objective panel exposes escape when the hunter reaches the exit', async ({ page }) => {
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
        await expect(occupants).toContainText('2 hunters here / 2 elsewhere');
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
        expect(requests).toContain('GET /api/state/apps/ar-eye-hunter/workspaces/default/clients');
        expect(requests).toContain('GET /api/state/apps/ar-eye-hunter/workspaces/default/groups');

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

        const pixels = new Uint8Array(4);
        gl.readPixels(
            Math.floor(gl.drawingBufferWidth / 2),
            Math.floor(gl.drawingBufferHeight / 2),
            1,
            1,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            pixels,
        );

        return pixels[3] > 0 && (pixels[0] > 4 || pixels[1] > 4 || pixels[2] > 4);
    });
}

function clientSnapshot(): MockClientSnapshot {
    const now = Date.now();
    return {
        principal: {
            applicationId: 'ar-eye-hunter',
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
                applicationId: 'ar-eye-hunter',
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
                applicationId: 'ar-eye-hunter',
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
            applicationId: 'ar-eye-hunter',
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
                applicationId: 'ar-eye-hunter',
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
                    applicationId: 'ar-eye-hunter',
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
    phase: 'lobby' | 'planning' = 'lobby',
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
        round?: number;
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

    const map = [
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

type MockClientSnapshot = Readonly<Record<string, unknown>>;
type MockGroupSnapshot = Readonly<Record<string, unknown>>;
type RelicSnapshot = Readonly<Record<string, unknown>>;
