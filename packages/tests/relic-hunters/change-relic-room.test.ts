import type { RelicPublicSnapshot } from '@relic-hunters/mod.ts';
import { describe, expect, it } from 'vitest';

import {
    changeRelicRoom,
    type RelicRoomChangeDependencies
} from '../../../apps/relic-hunters-v1/src/game/runtime/change-relic-room.ts';
import { createTimedOutRoundSnapshots } from './relic-timeout-snapshot-fixture.ts';

const ALICE = { sessionId: 'alice-session', clientId: 'alice' };

interface RoomChangeHarness {
    readonly dependencies: RelicRoomChangeDependencies;
    readonly locks: string[];
    readonly snapshotReads: string[];
    currentRoomId: string | undefined;
}

function createHarness(
    roomId: string | undefined,
    readSnapshot: (harness: RoomChangeHarness, roomId: string) => RelicPublicSnapshot | undefined
): RoomChangeHarness {
    const harness: RoomChangeHarness = {
        locks: [],
        snapshotReads: [],
        currentRoomId: roomId,
        dependencies: {
            session: () => ALICE,
            currentRoomId: () => harness.currentRoomId,
            withParticipationLock: async (lockedRoomId, sessionId, run) => {
                harness.locks.push(`${lockedRoomId}:${sessionId}`);
                return await run();
            },
            participation: { reconcile: async () => undefined },
            fetchSnapshot: async (snapshotRoomId) => {
                harness.snapshotReads.push(snapshotRoomId);
                return readSnapshot(harness, snapshotRoomId);
            }
        }
    };
    return harness;
}

describe('changeRelicRoom', () => {
    it('enters the destination when the current room releases the session during the check', async () => {
        const harness = createHarness('room-r', (current) => {
            current.currentRoomId = undefined;
            return createTimedOutRoundSnapshots().timedOut;
        });

        await expect(changeRelicRoom(harness.dependencies, async () => 'entered', 'room-r')).resolves.toBe('entered');
        expect(harness.locks).toEqual(['room-r:alice-session']);
    });

    it('checks a room that became current during the check under its own lock', async () => {
        const unfinished = createTimedOutRoundSnapshots().timedOut;
        const harness = createHarness('room-r', (current, roomId) => {
            current.currentRoomId = 'room-s';
            return roomId === 'room-s' ? unfinished : undefined;
        });

        await expect(changeRelicRoom(harness.dependencies, async () => 'entered', 'room-r')).rejects.toThrow(
            'Use Leave expedition before entering or watching another expedition.'
        );
        expect(harness.locks).toEqual(['room-r:alice-session', 'room-s:alice-session']);
        expect(harness.snapshotReads).toEqual(['room-r', 'room-s']);
    });

    it('still refuses an implicit leave of an unfinished expedition', async () => {
        const harness = createHarness('room-r', () => createTimedOutRoundSnapshots().timedOut);
        let changed = false;

        await expect(changeRelicRoom(harness.dependencies, async () => {
            changed = true;
        }, 'room-t')).rejects.toThrow('Use Leave expedition before entering or watching another expedition.');
        expect(changed).toBe(false);
    });

    it('refuses the entry when the current room keeps changing', async () => {
        let rooms = 0;
        const harness = createHarness('room-0', (current) => {
            rooms += 1;
            current.currentRoomId = `room-${rooms}`;
            return undefined;
        });
        let changed = false;

        await expect(changeRelicRoom(harness.dependencies, async () => {
            changed = true;
        }, 'room-t')).rejects.toThrow('Room entry changed while checking expedition participation.');
        expect(changed).toBe(false);
        expect(harness.locks).toEqual(['room-0:alice-session', 'room-1:alice-session', 'room-2:alice-session']);
    });
});
