import { expect, it } from 'vitest';
import { resolveTemporaryRoomCapacity } from '@shared/api/room-guests/temporary-room-policy.ts';

it('selects the application default or an allowed player count, including the creator', () => {
    const policy = { defaultCapacity: 4, maximumCapacity: 8 };
    expect(resolveTemporaryRoomCapacity(policy)).toBe(4);
    expect(resolveTemporaryRoomCapacity(policy, 1)).toBe(1);
    expect(resolveTemporaryRoomCapacity(policy, 8)).toBe(8);
    for (const invalid of [0, 8.1, 9, Number.NaN]) {
        expect(() => resolveTemporaryRoomCapacity(policy, invalid)).toThrow();
    }
});
