import { expect, it, vi } from 'vitest';
import { MarketAuthority } from '../../../apps/cca-server/src/market-authority.ts';
import { MARKET_SCOPE, type MarketInputMessage, type MarketSnapshot } from '../../cca-game/market-protocol.ts';

it('expires movement after 250ms, rejects old sequences, isolates rooms and caps two seats', () => {
    let now = 1000;
    const authority = new MarketAuthority({
        ws: { defineTopic: vi.fn(), on: vi.fn(), publish: vi.fn() },
        now: () => now,
        serverId: 'server',
        incarnation: 'current'
    });
    const input: MarketInputMessage = {
        version: 1,
        roomRef: { ...MARKET_SCOPE, groupId: 'one' },
        incarnation: 'current',
        controller: 'a',
        sequence: 1,
        x: 1,
        y: 0,
        bank: false,
        dash: 0
    };
    authority.acceptInput(input, 'alice');
    authority.acceptInput({ ...input, controller: 'b' }, 'bob');
    authority.acceptInput({ ...input, controller: 'c' }, 'third');
    authority.tick();
    expect(authority.getState('one')?.players).toHaveLength(2);
    expect(authority.getState('one')?.players[0].x).toBe(57);
    now += 250;
    authority.tick();
    expect(authority.getState('one')?.players[0].x).toBe(57);
    authority.acceptInput({ ...input, x: -1 }, 'alice');
    authority.tick();
    expect(authority.getState('one')?.players[0].x).toBe(57);
    authority.acceptInput({ ...input, sequence: 2, incarnation: 'old' }, 'alice');
    authority.acceptInput({ ...input, roomRef: { ...MARKET_SCOPE, groupId: 'two' } }, 'charlie');
    authority.tick();
    expect(authority.getState('two')?.players.map((player) => player.id)).toEqual(['charlie']);
    expect(authority.getState('one')?.players[0].x).toBe(57);
    now += 10_001;
    authority.tick();
    expect(authority.getState('one')?.players).toEqual([]);
    authority.stop();
    expect(authority.getState('two')).toBeUndefined();
});

it('accepts fresh dash edges after a quiet controller is replaced, without replaying the old dash', () => {
    let now = 1000;
    const authority = new MarketAuthority({
        ws: { defineTopic: vi.fn(), on: vi.fn(), publish: vi.fn() },
        now: () => now,
        serverId: 'server',
        incarnation: 'current'
    });
    const input: MarketInputMessage = {
        version: 1,
        roomRef: { ...MARKET_SCOPE, groupId: 'one' },
        incarnation: 'current',
        controller: 'old',
        sequence: 1,
        x: 0,
        y: 0,
        bank: false,
        dash: 5
    };
    authority.acceptInput(input, 'alice');
    authority.tick();
    now += 5000;
    for (let tick = 0; tick < 151; tick++) {
        authority.tick();
    }
    authority.acceptInput({ ...input, controller: 'new', dash: 0 }, 'alice');
    authority.tick();
    expect(authority.getState('one')?.players[0].lastDash).toBe(0);
    expect(authority.getState('one')?.players[0].dashRemaining).toBe(0);
    authority.acceptInput({ ...input, controller: 'new', sequence: 2, dash: 1 }, 'alice');
    authority.tick();
    expect(authority.getState('one')?.players[0].dashRemaining).toBeGreaterThan(0);
});

it('starts a new room generation after expiry and does not replay a returning seat’s consumed dash', async () => {
    let now = 1000;
    const snapshots: MarketSnapshot[] = [];
    const authority = new MarketAuthority({
        ws: {
            defineTopic: vi.fn(),
            on: vi.fn(),
            publish: async ({ message }) => {
                snapshots.push(JSON.parse(message.payload.resource));
                return { message, status: 'sent-live', fanout: 'live-only', entries: [] };
            }
        },
        now: () => now,
        serverId: 'server',
        incarnation: 'current'
    });
    const input: MarketInputMessage = {
        version: 1,
        roomRef: { ...MARKET_SCOPE, groupId: 'one' },
        incarnation: 'current',
        controller: 'same',
        sequence: 1,
        x: 0,
        y: 0,
        bank: false,
        dash: 0
    };
    authority.acceptInput(input, 'alice');
    authority.acceptInput({ ...input, sequence: 2, dash: 3 }, 'alice');
    authority.tick();
    expect(authority.getState('one')?.players[0].dashRemaining).toBeGreaterThan(0);
    now += 10_001;
    authority.tick();
    authority.acceptInput({ ...input, sequence: 3, dash: 3 }, 'alice');
    authority.tick();
    expect(authority.getState('one')?.players[0].dashRemaining).toBe(0);
    expect(authority.getState('one')?.players[0].y).toBe(328);
    await authority.publish();
    now += 60_001;
    authority.tick();
    authority.acceptInput({ ...input, sequence: 4, dash: 3 }, 'alice');
    authority.tick();
    await authority.publish();
    expect(snapshots[1].generation).toBeGreaterThan(snapshots[0].generation);
    expect(snapshots[1].state.tick).toBeLessThan(snapshots[0].state.tick);
    expect(snapshots[1].state.players[0].dashRemaining).toBe(0);
});
