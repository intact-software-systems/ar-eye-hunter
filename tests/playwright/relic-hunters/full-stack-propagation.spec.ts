import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { RELIC_TYPES } from '../../../packages/relic-hunters/src/protocol.ts';

const fullStackEnabled = process.env.RELIC_HUNTERS_FULL_STACK === '1' ||
    process.env.RELIC_HUNTERS_FULL_STACK === 'true';

type RuntimeHook = Readonly<{
    roomId?: string;
    diagnostics: Readonly<{
        phase: string;
        ignoredSnapshotCount: number;
        lastSnapshotSource?: string;
        lastIgnoredSnapshotReason?: string;
        lastAcceptedSnapshot?: Readonly<{
            source: string;
            phase: string;
            round: number;
            updatedAtEpochMs: number;
            eventCount: number;
            submittedCount: number;
        }>;
    }>;
    snapshot?: RuntimeSnapshot;
}>;

type RuntimeSnapshot = Readonly<{
    gameId: string;
    roomId: string;
    phase: string;
    round: number;
    updatedAtEpochMs: number;
    playerIds: readonly string[];
    activePlayerCount: number;
    submittedPlayerIds: readonly string[];
    eventIds: readonly string[];
    eventCount: number;
}>;

type ComparableSnapshot = Readonly<{
    gameId: string;
    roomId: string;
    phase: string;
    round: number;
    playerIds: readonly string[];
    activePlayerCount: number;
    submittedPlayerIds: readonly string[];
    eventIds: readonly string[];
}>;

test.describe('full-stack Relic Hunters two-client propagation', () => {
    test.skip(
        !fullStackEnabled,
        'Set RELIC_HUNTERS_FULL_STACK=1 and run apps/relic-hunters-v1/playwright.full-stack.config.ts against the paired Relic server.'
    );

    test('two browsers converge through join, start, submit, reset, and reload recovery', async ({ browser, request }) => {
        test.setTimeout(180_000);

        const configResponse = await request.get('/api/config');
        expect(configResponse.ok()).toBe(true);

        const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const contextA = await browser.newContext();
        const contextB = await browser.newContext();
        const pageA = await contextA.newPage();
        const pageB = await contextB.newPage();

        try {
            await enterLobbyWithTwoHunters(pageA, pageB, suffix);

            await expect(pageA.locator('.lobby-begin-btn')).toBeEnabled();
            await pageA.locator('.lobby-begin-btn').click();
            await expectConverged(pageA, pageB, {
                phase: 'planning',
                round: 1,
                playerCount: 2,
                submittedCount: 0
            });

            await pageA.getByRole('button', { name: 'Submit Plan' }).click();
            await expectConverged(pageA, pageB, {
                phase: 'planning',
                round: 1,
                playerCount: 2,
                submittedCount: 1
            });

            await pageB.getByRole('button', { name: 'Submit Plan' }).click();
            await expectConverged(pageA, pageB, {
                phase: 'planning',
                round: 2,
                playerCount: 2,
                submittedCount: 0,
                minEventCount: 3
            });

            await pageB.reload();
            await expect(pageB.getByRole('button', { name: 'Refresh' })).toBeVisible();
            await expectConverged(pageA, pageB, {
                phase: 'planning',
                round: 2,
                playerCount: 2,
                submittedCount: 0,
                minEventCount: 3
            });

            await pageA.getByRole('button', { name: 'Reset' }).click();
            await expectConverged(pageA, pageB, {
                phase: 'lobby',
                round: 1,
                playerCount: 0,
                submittedCount: 0
            });

            await pageA.getByRole('button', { name: /Join as/ }).click();
            await pageB.getByRole('button', { name: /Join as/ }).click();
            await expectConverged(pageA, pageB, {
                phase: 'lobby',
                round: 1,
                playerCount: 2,
                submittedCount: 0
            });

            const [runtimeA, runtimeB] = await Promise.all([
                readRuntime(pageA),
                readRuntime(pageB)
            ]);
            expect(runtimeA?.diagnostics.lastSnapshotSource).toBeTruthy();
            expect(runtimeB?.diagnostics.lastSnapshotSource).toBeTruthy();
            expect(runtimeA?.diagnostics.lastIgnoredSnapshotReason).toBeUndefined();
            expect(runtimeB?.diagnostics.lastIgnoredSnapshotReason).toBeUndefined();
        }
        finally {
            await Promise.all([
                contextA.close(),
                contextB.close()
            ]);
        }
    });

    // The command's WS frame never reaches the server, so only the page's checkpoint carries it across the reload.
    test('a start command held on its WS leg survives a reload inside its deadline and is applied once', async ({ browser }) => {
        test.setTimeout(180_000);

        const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const contextA = await browser.newContext();
        const contextB = await browser.newContext();
        const commandHold = await routeRelicCommandHold(contextA);
        const pageA = await contextA.newPage();
        const pageB = await contextB.newPage();

        try {
            await enterLobbyWithTwoHunters(pageA, pageB, suffix);
            const eventCount = (await readRuntime(pageA))?.snapshot?.eventCount ?? 0;

            commandHold.hold();
            await pageA.locator('.lobby-begin-btn').click();
            await expect.poll(() => commandHold.heldCount()).toBeGreaterThan(0);
            // An admission inside the last checkpoint interval is lost with its page, so the reload waits one out.
            await pageA.waitForTimeout(CHECKPOINT_SETTLE_MS);
            expect((await readRuntime(pageB))?.snapshot?.phase).toBe('lobby');
            commandHold.release();
            await pageA.reload();

            await expectConverged(pageA, pageB, {
                phase: 'planning',
                round: 1,
                playerCount: 2,
                submittedCount: 0,
                minEventCount: eventCount + 1
            });
            await waitForRuntime(pageA, (runtime) => runtime.diagnostics.phase === 'ready');
            // A second application would append a second start event; give a repeat time to land before counting.
            await pageA.waitForTimeout(REPEAT_WINDOW_MS);
            const [runtimeA, runtimeB] = await Promise.all([readRuntime(pageA), readRuntime(pageB)]);
            expect(runtimeA?.snapshot?.eventCount).toBe(eventCount + 1);
            expect(runtimeB?.snapshot?.eventCount).toBe(eventCount + 1);
        }
        finally {
            await Promise.all([
                contextA.close(),
                contextB.close()
            ]);
        }
    });
});

/** One checkpoint interval (1 s, the browser default) and a margin. */
const CHECKPOINT_SETTLE_MS = 2_000;
const REPEAT_WINDOW_MS = 3_000;
const RALLAR_WS_PATH = /\/api\/ws\//;

interface RelicCommandHold {
    hold(): void;
    release(): void;
    heldCount(): number;
}

/**
 * Withholds the page's Relic command frames from the server while held, as a carrier that accepted them and never
 * delivered. Every other frame, and every frame of a socket opened after the release, goes through.
 */
async function routeRelicCommandHold(context: BrowserContext): Promise<RelicCommandHold> {
    let holding = false;
    let held = 0;
    await context.routeWebSocket(RALLAR_WS_PATH, (socket) => {
        const server = socket.connectToServer();
        socket.onMessage((message) => {
            if (holding && String(message).includes(RELIC_TYPES.command)) {
                held += 1;
                return;
            }
            server.send(message);
        });
    });
    return {
        hold: () => {
            holding = true;
        },
        release: () => {
            holding = false;
        },
        heldCount: () => held
    };
}

/** Two hunters register, Alice opens a room, both join it, and both pages agree on the lobby. */
async function enterLobbyWithTwoHunters(pageA: Page, pageB: Page, suffix: string): Promise<void> {
    await registerHunter(pageA, {
        username: `alice-${suffix}`,
        displayName: 'Alice',
        password: `alice-pass-${suffix}`
    });
    await registerHunter(pageB, {
        username: `bob-${suffix}`,
        displayName: 'Bob',
        password: `bob-pass-${suffix}`
    });

    await pageA.getByRole('button', { name: 'New Room' }).click();
    await expect(pageA.getByRole('button', { name: /Join as/ })).toBeVisible();
    const roomId = await waitForRoomId(pageA);

    await pageB.getByRole('button', { name: 'Refresh' }).click();
    const roomButtonB = pageB.locator(`button.room-row[data-room-id="${roomId}"]`);
    await expect(roomButtonB).toBeVisible();
    await roomButtonB.click();
    await waitForRuntime(pageB, (runtime) => runtime.roomId === roomId);

    await pageA.getByRole('button', { name: /Join as/ }).click();
    await expectConverged(pageA, pageB, {
        phase: 'lobby',
        round: 1,
        playerCount: 1,
        submittedCount: 0
    });

    await pageB.getByRole('button', { name: /Join as/ }).click();
    await expectConverged(pageA, pageB, {
        phase: 'lobby',
        round: 1,
        playerCount: 2,
        submittedCount: 0
    });
}

async function registerHunter(
    page: Page,
    input: Readonly<{
        username: string;
        displayName: string;
        password: string;
    }>
): Promise<void> {
    await page.goto('/');
    await page.getByRole('button', { name: 'Register' }).click();
    await page.getByLabel('Username').fill(input.username);
    await page.getByLabel('Display name').fill(input.displayName);
    await page.getByLabel('Password').fill(input.password);
    await page.getByRole('button', { name: 'Create Hunter' }).click();
    await expect(page.getByRole('button', { name: 'New Room' })).toBeVisible();
}

async function waitForRoomId(page: Page): Promise<string> {
    await expect.poll(async () => {
        const runtime = await readRuntime(page);
        return runtime?.roomId;
    }, {
        timeout: 30_000
    }).toBeTruthy();

    const runtime = await readRuntime(page);
    if (!runtime?.roomId) {
        throw new Error('Relic Hunters runtime did not expose a room id.');
    }

    return runtime.roomId;
}

async function expectConverged(
    pageA: Page,
    pageB: Page,
    expected: Readonly<{
        phase: string;
        round: number;
        playerCount: number;
        submittedCount: number;
        minEventCount?: number;
    }>
): Promise<ComparableSnapshot> {
    let lastA: RuntimeHook | undefined;
    let lastB: RuntimeHook | undefined;

    await expect.poll(async () => {
        [lastA, lastB] = await Promise.all([
            readRuntime(pageA),
            readRuntime(pageB)
        ]);
        if (!lastA?.snapshot || !lastB?.snapshot) {
            return undefined;
        }

        const left = comparableSnapshot(lastA.snapshot);
        const right = comparableSnapshot(lastB.snapshot);
        if (JSON.stringify(left) !== JSON.stringify(right)) {
            return undefined;
        }

        if (
            left.phase !== expected.phase ||
            left.round !== expected.round ||
            left.playerIds.length !== expected.playerCount ||
            left.activePlayerCount !== expected.playerCount ||
            left.submittedPlayerIds.length !== expected.submittedCount ||
            left.eventIds.length < (expected.minEventCount ?? 0)
        ) {
            return undefined;
        }

        return left;
    }, {
        timeout: 45_000
    }).toBeTruthy();

    if (!lastA?.snapshot || !lastB?.snapshot) {
        throw new Error('Relic Hunters clients did not expose comparable snapshots.');
    }

    expect(lastA.diagnostics.lastAcceptedSnapshot).toBeTruthy();
    expect(lastB.diagnostics.lastAcceptedSnapshot).toBeTruthy();
    return comparableSnapshot(lastA.snapshot);
}

async function waitForRuntime(
    page: Page,
    predicate: (runtime: RuntimeHook) => boolean
): Promise<void> {
    await expect.poll(async () => {
        const runtime = await readRuntime(page);
        return runtime ? predicate(runtime) : false;
    }, {
        timeout: 30_000
    }).toBe(true);
}

async function readRuntime(page: Page): Promise<RuntimeHook | undefined> {
    return await page.evaluate(() =>
        (window as unknown as { __relicHuntersRuntime?: RuntimeHook; }).__relicHuntersRuntime
    );
}

function comparableSnapshot(snapshot: RuntimeSnapshot): ComparableSnapshot {
    return {
        gameId: snapshot.gameId,
        roomId: snapshot.roomId,
        phase: snapshot.phase,
        round: snapshot.round,
        playerIds: [...snapshot.playerIds],
        activePlayerCount: snapshot.activePlayerCount,
        submittedPlayerIds: [...snapshot.submittedPlayerIds],
        eventIds: [...snapshot.eventIds]
    };
}
