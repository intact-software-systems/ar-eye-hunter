import { describe, expect, it } from 'vitest';
import {
    createRelicGame,
    toPublicRelicSnapshot,
    type RelicPublicSnapshot,
} from '@relic-hunters/mod.ts';
import { shouldAcceptRelicSnapshot } from './relic-snapshot-ordering.ts';

const NOW = 1_700_000_000_000;

describe('shouldAcceptRelicSnapshot', () => {
    it('rejects older snapshots for the current room', () => {
        const current = snapshot('room-1', NOW + 10);
        const candidate = snapshot('room-1', NOW + 5);

        expect(shouldAcceptRelicSnapshot({
            current,
            candidate,
            expectedRoomId: 'room-1',
        })).toBe(false);
    });

    it('accepts equal-timestamp snapshots so REST and WS echoes converge', () => {
        const current = snapshot('room-1', NOW + 10);
        const candidate = {
            ...current,
            submittedPlayerIds: ['alice-session'],
        };

        expect(shouldAcceptRelicSnapshot({
            current,
            candidate,
            expectedRoomId: 'room-1',
        })).toBe(true);
    });

    it('rejects snapshots for a room that is no longer current', () => {
        const current = snapshot('room-1', NOW + 10);
        const candidate = snapshot('room-2', NOW + 20);

        expect(shouldAcceptRelicSnapshot({
            current,
            candidate,
            expectedRoomId: 'room-1',
        })).toBe(false);
    });

    it('accepts snapshots for the newly selected room even if its clock is older', () => {
        const current = snapshot('room-1', NOW + 10);
        const candidate = snapshot('room-2', NOW + 1);

        expect(shouldAcceptRelicSnapshot({
            current,
            candidate,
            expectedRoomId: 'room-2',
        })).toBe(true);
    });
});

function snapshot(
    roomId: string,
    updatedAtEpochMs: number,
    round = 1,
): RelicPublicSnapshot {
    const base = toPublicRelicSnapshot(createRelicGame(roomId, roomId, updatedAtEpochMs));
    return {
        ...base,
        round,
        updatedAtEpochMs,
    };
}
