import { describe, expect, it } from 'vitest';
import { computeMarketTick, createMarket, createRunner, MARKET_BANKS, type MarketState } from '../../cca-game/market-rules.ts';

describe('market rules', () => {
    it('moves at the same speed diagonally and stops at solid stalls', () => {
        const runner = createRunner('one', 0);
        const start = { ...runner, x: 192, y: 192 };
        const straight = computeMarketTick({ ...createMarket(), players: [start] }, [{ id: 'one', x: 1, y: 0, bank: false, dash: 0 }], 1 / 30);
        const diagonal = computeMarketTick({ ...createMarket(), players: [start] }, [{ id: 'one', x: 1, y: 1, bank: false, dash: 0 }], 1 / 30);
        expect(straight.players[0].x - 192).toBeCloseTo(3);
        expect(Math.hypot(diagonal.players[0].x - 192, diagonal.players[0].y - 192)).toBeCloseTo(3);
        const atStall = { ...runner, x: 54, y: 125 };
        const blocked = computeMarketTick({ ...createMarket(), players: [atStall] }, [{ id: 'one', x: 0, y: -1, bank: false, dash: 0 }], 1 / 30);
        expect(blocked.players[0].y).toBe(125);
    });
    it('consumes a dash edge once and enforces cooldown', () => {
        let state: MarketState = { ...createMarket(), players: [{ ...createRunner('one', 0), x: 192, y: 192 }] };
        const control = { id: 'one', x: 1, y: 0, bank: false, dash: 1 };
        state = computeMarketTick(state, [control], 1 / 30);
        expect(state.players[0].x).toBeCloseTo(201);
        for (let tick = 0; tick < 140; tick++) {
            state = computeMarketTick(state, [control], 1 / 30);
        }
        expect(state.players[0].dashRemaining).toBe(0);
        expect(state.players[0].lastDash).toBe(1);
    });
    it('awards each coin to only one runner and never exceeds bag capacity', () => {
        const coin = createMarket().coins[0];
        const players = ['one', 'two'].map((id, index) => ({ ...createRunner(id, index), x: coin.x, y: coin.y, bag: 29 }));
        const state = computeMarketTick({ ...createMarket(), players }, [], 1 / 30);
        expect(state.players.map((player) => player.bag)).toEqual([30, 29]);
        expect(state.coins[0].availableAt).toBeGreaterThan(state.elapsed);
    });
    it('requires a continuous bank hold in a bank zone and banks only once', () => {
        const runner = { ...createRunner('one', 0), ...MARKET_BANKS[0], bag: 10 };
        let state: MarketState = { ...createMarket(), players: [runner] };
        const control = { id: 'one', x: 0, y: 0, bank: true, dash: 0 };
        for (let tick = 0; tick < 26; tick++) {
            state = computeMarketTick(state, [control], 1 / 30);
        }
        expect(state.players[0].banked).toBe(0);
        state = computeMarketTick(state, [], 1 / 30);
        expect(state.players[0].deposit).toBe(0);
        for (let tick = 0; tick < 60; tick++) {
            state = computeMarketTick(state, [control], 1 / 30);
        }
        expect(state.players[0].banked).toBe(12);
        expect(state.players[0].bag).toBe(0);
    });
});
