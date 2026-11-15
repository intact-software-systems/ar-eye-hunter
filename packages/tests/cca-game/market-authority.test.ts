import { expect, it, vi } from 'vitest';
import { MarketAuthority } from '../../../apps/cca-server/src/market-authority.ts';
import { MARKET_SCOPE, type MarketInputMessage } from '../../cca-game/market-protocol.ts';

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
