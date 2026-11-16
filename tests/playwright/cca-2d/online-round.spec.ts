import { expect, test, type Page } from '@playwright/test';

import { decodeTownMatchSnapshot } from '../../../apps/cca-2d/src/match/match-snapshot.ts';
import type { TownMatchState } from '../../../apps/cca-2d/src/match/town-match.ts';

import { decodeMatchWire, startTownMatch } from './match-browser.ts';

/** Observes real checkpoint traffic; all actions still use the visible browser controls. */
class MatchBrowser {
    readonly page: Page;
    readonly username: string;
    private readonly proposals = new Map<string, TownMatchState>();

    constructor(page: Page, username: string) {
        this.page = page;
        this.username = username;
        page.on('websocket', (socket) => {
            socket.on('framesent', ({ payload }) => this.record(payload));
            socket.on('framereceived', ({ payload }) => this.record(payload));
        });
    }

    async readDisplayedState(): Promise<TownMatchState | undefined> {
        const key = await this.page.locator('#online-game').evaluate((element) =>
            [
                element.getAttribute('data-match-id'),
                element.getAttribute('data-phase'),
                element.getAttribute('data-tick')
            ]
                .join(':')
        );
        return this.proposals.get(key);
    }

    async walk(destination: { axis: 'x' | 'z'; value: number; }): Promise<void> {
        const id = (await this.readDisplayedState())?.participants.find((player) =>
            player.displayName === this.username
        )?.id;
        const position = async () =>
            (await this.readDisplayedState())?.players.find((player) => player.id === id)?.[destination.axis];
        const current = await position();
        expect(current).toBeDefined();
        const positive = destination.value > current!;
        const key = destination.axis === 'x' ? positive ? 'KeyD' : 'KeyA' : positive ? 'KeyW' : 'KeyS';
        await expect(this.page.getByRole('button', { name: 'Dash and drop', exact: true })).toBeEnabled();
        await this.page.keyboard.down(key);
        try {
            await expect.poll(async () => {
                const value = await position();
                return value !== undefined && (positive ? value >= destination.value : value <= destination.value);
            }, { intervals: [30], timeout: 12000 }).toBe(true);
        }
        finally {
            await this.page.keyboard.up(key);
        }
    }

    private record(payload: string | Buffer): void {
        const frame = decodeMatchWire(payload);
        if (frame?.action.kind !== 'proposal') {
            return;
        }
        const state = decodeTownMatchSnapshot(frame.action.snapshot).right;
        if (state) {
            this.proposals.set(`${state.matchId}:${state.phase}:${state.tick}`, state);
            if (this.proposals.size > 32) {
                this.proposals.delete(this.proposals.keys().next().value!);
            }
        }
    }
}

test('friends share a fruit prank, finish the real timed round and start a clean rematch', async ({ browser }) => {
    test.setTimeout(300000);
    const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
    const pages = await Promise.all(contexts.map((context) => context.newPage()));
    const names = [`cca-round-alice-${Date.now()}`, `cca-round-bob-${Date.now()}`];
    const [alice, bob] = pages.map((page, index) => new MatchBrowser(page, names[index]));
    const errors: string[] = [];
    pages.forEach((page) => page.on('pageerror', (error) => errors.push(error.message)));
    try {
        await startTownMatch(pages, names);
        for (const player of [alice, bob]) {
            await expect.poll(async () =>
                (await player.readDisplayedState())?.participants.map((participant) => participant.displayName).sort()
            )
                .toEqual([...names].sort());
        }
        const matchId = await bob.page.locator('#online-game').getAttribute('data-match-id');
        await bob.walk({ axis: 'x', value: 5 });
        await bob.walk({ axis: 'z', value: 0.4 });
        await bob.page.keyboard.down('KeyW');
        await bob.page.getByRole('button', { name: 'Dash and drop', exact: true }).tap();
        await expect(bob.page.locator('#round-score')).toHaveText('10 / 100 POINTS');
        await bob.page.keyboard.up('KeyW');
        for (const player of [alice, bob]) {
            await expect.poll(async () => (await player.readDisplayedState())?.town.spills).toBe(1);
            await expect.poll(async () =>
                (await player.readDisplayedState())?.town.npcs.find((npc) => npc.shopId === 'apples')?.mode
            )
                .toBe('cleaning');
        }
        await expect(alice.page.locator('#round-score')).toHaveText('0 / 100 POINTS');
        await bob.page.screenshot({ path: test.info().outputPath('shared-fruit-prank-phone.png') });
        await bob.walk({ axis: 'z', value: -2 });
        await expect.poll(async () => (await alice.readDisplayedState())?.town.cleaned, { timeout: 30000 })
            .toBeGreaterThan(0);
        for (const player of [alice, bob]) {
            await expect(player.page.getByRole('heading', { name: 'Round complete', exact: true }))
                .toBeVisible({ timeout: 220000 });
            await expect(player.page.locator('#round-clock')).toHaveText('0s');
            await expect(player.page.locator('#round-winners')).toContainText(names[0]);
            await expect(player.page.locator('#round-winners')).toContainText(names[1]);
            expect((await player.readDisplayedState())?.remainingTicks).toBe(0);
            expect((await player.readDisplayedState())?.tick).toBe(5400);
        }
        await expect(bob.page.locator('#round-winners'))
            .toHaveText((await alice.page.locator('#round-winners').textContent())!);
        await bob.page.screenshot({ path: test.info().outputPath('shared-round-results-phone.png') });
        await alice.page.getByRole('button', { name: 'New round', exact: true }).click();
        for (const player of [alice, bob]) {
            await expect(player.page.getByRole('button', { name: 'Ready', exact: true })).toBeEnabled();
            await player.page.getByRole('button', { name: 'Ready', exact: true }).click();
        }
        await alice.page.getByRole('button', { name: 'Start round', exact: true }).click();
        for (const player of [alice, bob]) {
            await expect(player.page.locator('#online-game')).toHaveAttribute('data-phase', 'playing');
            await expect(player.page.locator('#online-game')).not.toHaveAttribute('data-match-id', matchId!);
            await expect(player.page.locator('#round-score')).toHaveText('0 / 100 POINTS');
            expect((await player.readDisplayedState())?.town.spills).toBe(0);
        }
        expect(errors).toEqual([]);
    }
    finally {
        await Promise.allSettled(contexts.map((context) => context.close()));
    }
});
