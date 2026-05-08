import { expect, test, type Page, type Route } from '@playwright/test';

type MockBackendOptions = Readonly<{
    rooms?: readonly MockGroupSnapshot[];
    relicSnapshot?: RelicSnapshot;
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
            return json(route, options.relicSnapshot ?? relicSnapshotWithPlayers(1));
        }

        if (path === '/api/relic/games/room-1/reset') {
            return json(route, emptyRelicSnapshot());
        }

        if (path === '/api/relic/games/room-1/commands') {
            options.commandBodies?.push(parseJsonBody(request.postData()));
            return json(route, relicSnapshotWithPlayers(1));
        }

        if (path.endsWith('/clients') && request.method() === 'GET') {
            return json(route, [clientSnapshot()]);
        }

        if (path.endsWith('/groups') && request.method() === 'GET') {
            return json(route, options.rooms ?? []);
        }

        if (path.includes('/groups/room-1/') || path.endsWith('/groups/room-1')) {
            return json(route, groupSnapshot({ onlineMemberCount: 1 }));
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
    playerCount: 1 | 2,
    phase: 'lobby' | 'planning' = 'lobby',
): RelicSnapshot {
    const players = [
        {
            playerId: 'alice-session',
            username: 'Alice',
            characterId: 'kael-ironstride',
            roomId: 'entrance',
            health: 3,
            escaped: false,
            defeated: false,
            score: 0,
            relicIds: [],
        },
    ];
    if (playerCount === 2) {
        players.push({
            playerId: 'bob-session',
            username: 'Bob',
            characterId: 'nyra-vale',
            roomId: 'entrance',
            health: 3,
            escaped: false,
            defeated: false,
            score: 0,
            relicIds: [],
        });
    }

    return {
        protocolVersion: 1,
        gameId: 'room-1',
        roomId: 'room-1',
        phase,
        round: 1,
        maxRounds: 10,
        updatedAtEpochMs: Date.now(),
        map: [
            {
                id: 'entrance',
                name: 'Entrance',
                kind: 'entrance',
                x: 0,
                z: -6,
                neighbors: ['hallway'],
            },
            {
                id: 'hallway',
                name: 'Hallway',
                kind: 'hallway',
                x: 0,
                z: -3,
                neighbors: ['entrance'],
            },
        ],
        relics: [],
        players,
        submittedPlayerIds: [],
        events: [],
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

type MockClientSnapshot = Readonly<Record<string, unknown>>;
type MockGroupSnapshot = Readonly<Record<string, unknown>>;
type RelicSnapshot = Readonly<Record<string, unknown>>;
