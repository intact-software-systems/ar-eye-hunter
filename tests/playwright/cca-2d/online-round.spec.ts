import {
    expect,
    test,
    type Page
} from '@playwright/test';
import { appendFile, writeFile } from 'node:fs/promises';

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
        const actor = async () => (await this.readDisplayedState())?.players.find((player) => player.id === id);
        for (let attempt = 0; attempt < 16; attempt += 1) {
            const current = await actor();
            expect(current).toBeDefined();
            if (current!.frozenUntil > current!.elapsed) {
                await expect.poll(async () => {
                    const thawed = await actor();
                    return thawed && thawed.frozenUntil <= thawed.elapsed;
                }, { timeout: 8000 }).toBe(true);
                continue;
            }
            const distance = destination.value - current![destination.axis];
            if (Math.abs(distance) < 0.3) {
                return;
            }
            const positive = distance > 0;
            const key = destination.axis === 'x' ? positive ? 'KeyD' : 'KeyA' : positive ? 'KeyW' : 'KeyS';
            const tick = (await this.readDisplayedState())!.tick;
            await this.page.keyboard.press(key, {
                delay: Math.min(700, Math.max(150, (Math.abs(distance) - 0.2) / 3.6 * 1000))
            });
            await expect.poll(async () => (await this.readDisplayedState())?.tick, { intervals: [50] })
                .toBeGreaterThan(tick + 9);
            await expect.poll(async () => {
                const stopped = await actor();
                return stopped ? Math.hypot(stopped.vx, stopped.vz) : 1;
            }, { intervals: [50], timeout: 8000 }).toBeLessThan(0.15);
        }
        expect(Math.abs(destination.value - (await actor())![destination.axis])).toBeLessThan(0.3);
    }

    async dashNorth(): Promise<void> {
        await expect.poll(async () => {
            const state = await this.readDisplayedState();
            const id = state?.participants.find((participant) => participant.displayName === this.username)?.id;
            return state?.players.find((player) => player.id === id)?.cooldown;
        }).toBe(0);
        await appendFile(
            test.info().outputPath('dash-approaches.jsonl'),
            JSON.stringify({
                username: this.username,
                state: await this.readDisplayedState()
            }) + '\n'
        );
        const before = (await this.readDisplayedState())?.town.mischief;
        expect(before).toBeDefined();
        await this.page.keyboard.down('KeyW');
        try {
            await expect.poll(async () => {
                const state = await this.readDisplayedState();
                const id = state?.participants.find((participant) => participant.displayName === this.username)?.id;
                return state?.players.find((player) => player.id === id)?.facingZ;
            }).toBe(1);
            await this.page.getByRole('button', { name: 'Dash and drop', exact: true }).tap();
            await expect.poll(async () => (await this.readDisplayedState())?.town.mischief).toBeGreaterThan(before!);
        }
        finally {
            await this.page.keyboard.up('KeyW');
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

async function provokeRaid(player: MatchBrowser): Promise<void> {
    const before = (await player.readDisplayedState())!.town.raid.bonuses;
    const route = [
        ['z', -3.8, false],
        ['x', -3.5, true],
        ['z', -4, false],
        ['x', 0, false],
        ['z', -8, false],
        ['x', -5.5, true],
        ['z', -8, false],
        ['x', -3, true],
        ['z', -8, false],
        ['x', 5, false],
        ['z', -6, true],
        ['x', 7, false],
        ['z', 0.5, false],
        ['x', 5, true],
        ['z', 0, false],
        ['x', 2.5, false],
        ['z', 6, false],
        ['x', 0, true]
    ] as const;
    for (const [axis, value, dash] of route) {
        await player.walk({ axis, value });
        if (dash) {
            await player.dashNorth();
            const state = (await player.readDisplayedState())!;
            if (state.town.raid.bonuses > before) {
                return;
            }
        }
    }
    const state = (await player.readDisplayedState())!;
    expect(state.town.raid.bonuses).toBeGreaterThan(before);
}

test('a friend rescues a frozen player and both qualify in the same timed round', async ({ browser }) => {
    test.setTimeout(300000);
    const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
    const pages = await Promise.all(contexts.map((context) => context.newPage()));
    const names = [`cca-rescue-alice-${Date.now()}`, `cca-rescue-bob-${Date.now()}`];
    const [alice, bob] = pages.map((page, index) => new MatchBrowser(page, names[index]));
    const errors: string[] = [];
    pages.forEach((page) => page.on('pageerror', (error) => errors.push(error.message)));
    try {
        await startTownMatch(pages, names);
        await Promise.all([
            provokeRaid(bob),
            (async () => {
                await alice.walk({ axis: 'x', value: 2.5 });
                await alice.walk({ axis: 'z', value: 10.8 });
                await alice.walk({ axis: 'x', value: 1.4 });
            })()
        ]);
        await bob.walk({ axis: 'x', value: 2.5 });
        await bob.walk({ axis: 'z', value: 10.8 });
        await alice.walk({
            axis: 'x',
            value: Number(await bob.page.locator('#online-game').getAttribute('data-x')) - 0.7
        });
        await expect.poll(async () => {
            const players = (await alice.readDisplayedState())?.players;
            return players ? Math.hypot(players[0].x - players[1].x, players[0].z - players[1].z) : Infinity;
        }).toBeLessThan(1.6);
        let frozen: TownMatchState | undefined;
        await expect.poll(
            async () => {
                frozen = await alice.readDisplayedState();
                return frozen?.players.some((player) => player.frozenUntil > player.elapsed);
            },
            { timeout: 15000 }
        ).toBe(true);
        const target = frozen!.players.find((player) => player.frozenUntil > player.elapsed)!;
        const rescueCount = frozen!.town.rescues;
        let rescued: TownMatchState | undefined;
        await Promise.all([
            alice.page.screenshot({ path: test.info().outputPath('shared-freeze-phone.png') }),
            expect.poll(async () => {
                rescued = await alice.readDisplayedState();
                const freed = rescued?.players.find((player) => player.id === target.id);
                return rescued && freed && rescued.town.rescues > rescueCount && freed.frozenUntil === 0 &&
                    freed.elapsed < target.frozenUntil && freed.shieldUntil > freed.elapsed;
            }, { intervals: [50], timeout: 5000 }).toBe(true)
        ]);
        for (const player of [alice, bob]) {
            await expect.poll(async () => (await player.readDisplayedState())?.town.rescues)
                .toBeGreaterThan(rescueCount);
        }
        expect(rescued!.town.companion).toBeUndefined();
        expect(rescued!.players.some((player) => player.rescues > 0)).toBe(true);
        await alice.page.screenshot({ path: test.info().outputPath('shared-rescue-phone.png') });
        await expect.poll(async () => (await alice.readDisplayedState())?.town.raid.phase, { timeout: 30000 })
            .toBe('returning');
        await alice.walk({ axis: 'x', value: 2.5 });
        await alice.walk({ axis: 'z', value: -12 });
        await alice.walk({ axis: 'x', value: 3 });
        await expect.poll(async () => {
            const state = await alice.readDisplayedState();
            const id = state?.participants.find((participant) => participant.displayName === names[0])?.id;
            return state?.players.find((player) => player.id === id)?.power;
        }).toBe('poop-bomb');
        await alice.walk({ axis: 'x', value: -11.5 });
        await alice.walk({ axis: 'z', value: -10.5 });
        await alice.walk({ axis: 'x', value: -14 });
        await alice.dashNorth();
        await expect.poll(async () => (await alice.readDisplayedState())?.town.spectacles.fireReadyAt)
            .toBeGreaterThan(0);
        await alice.walk({ axis: 'x', value: -11.5 });
        await alice.walk({ axis: 'z', value: -3.5 });
        await alice.dashNorth();
        for (const player of [alice, bob]) {
            await expect.poll(async () =>
                (await player.readDisplayedState())?.players.filter((actor) => actor.score >= 100).length
            ).toBe(2);
            await expect(player.page.getByRole('heading', { name: 'Round complete', exact: true }))
                .toBeVisible({ timeout: 220000 });
            const results = (await player.readDisplayedState())?.results;
            expect(results?.filter((result) => result.qualified).map((result) => result.displayName).sort())
                .toEqual([...names].sort());
            expect((await player.page.locator('#round-winners').innerText()).match(/WINNER!/g)).toHaveLength(2);
            for (const result of results!) {
                await expect(player.page.locator('#round-winners'))
                    .toContainText(`${result.displayName}: ${result.score} — WINNER!`);
            }
        }
        await expect(bob.page.locator('#round-winners'))
            .toHaveText((await alice.page.locator('#round-winners').textContent())!);
        await alice.page.screenshot({ path: test.info().outputPath('shared-winners-phone.png') });
        expect(errors).toEqual([]);
    }
    finally {
        try {
            for (const [index, player] of [alice, bob].entries()) {
                const path = test.info().outputPath(`final-shared-state-${index}.json`);
                await writeFile(path, JSON.stringify(await player.readDisplayedState()));
                await test.info().attach(`final-shared-state-${index}`, { path, contentType: 'application/json' });
            }
        }
        finally {
            await Promise.allSettled(contexts.map((context) => context.close()));
        }
    }
});
