import type { RelicPublicSnapshot } from '@relic-hunters/mod.ts';
import { describe, expect, it } from 'vitest';

import {
    changeRelicRoom,
    type RelicRoomChangeDependencies
} from '../../../apps/relic-hunters-v1/src/game/runtime/change-relic-room.ts';
import { createTimedOutRoundSnapshots } from './relic-timeout-snapshot-fixture.ts';

const ALICE = { sessionId: 'alice-session', clientId: 'alice' };
const ROOM_ENTRY_CHANGED = 'Room entry changed while checking expedition participation.';
const UNFINISHED_EXPEDITION = 'Use Leave expedition before entering or watching another expedition.';

interface RoomChangeHarness {
    readonly dependencies: RelicRoomChangeDependencies;
    readonly locks: string[];
    readonly reconciles: string[];
    readonly snapshotReads: string[];
    session: typeof ALICE;
    currentRoomId: string | undefined;
}

function createHarness(
    roomId: string | undefined,
    readSnapshot: (harness: RoomChangeHarness, roomId: string) => RelicPublicSnapshot | undefined,
    acquireLock: (harness: RoomChangeHarness) => void = () => undefined
): RoomChangeHarness {
    const harness: RoomChangeHarness = {
        locks: [],
        reconciles: [],
        snapshotReads: [],
        session: ALICE,
        currentRoomId: roomId,
        dependencies: {
            session: () => harness.session,
            currentRoomId: () => harness.currentRoomId,
            withParticipationLock: async (lockedRoomId, sessionId, run) => {
                harness.locks.push(`${lockedRoomId}:${sessionId}`);
                acquireLock(harness);
                return await run();
            },
            participation: {
                reconcile: async (reconciledRoomId) => {
                    harness.reconciles.push(reconciledRoomId);
                }
            },
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

    it('enters another room even with an unfinished snapshot when the current room releases the session during the check: the session\'s presence has already left that room, so the join issues no implicit leave', async () => {
        const harness = createHarness('room-r', (current) => {
            current.currentRoomId = undefined;
            return createTimedOutRoundSnapshots().timedOut;
        });

        await expect(changeRelicRoom(harness.dependencies, async () => 'entered', 'room-t')).resolves.toBe('entered');
        expect(harness.locks).toEqual(['room-r:alice-session']);
    });

    it('follows a room that moves while its lock is acquired without checking the room it left', async () => {
        const harness = createHarness('room-r', () => createTimedOutRoundSnapshots().timedOut, (current) => {
            current.currentRoomId = undefined;
        });

        await expect(changeRelicRoom(harness.dependencies, async () => 'entered', 'room-t')).resolves.toBe('entered');
        expect(harness.locks).toEqual(['room-r:alice-session']);
        expect(harness.reconciles).toEqual([]);
        expect(harness.snapshotReads).toEqual([]);
    });

    it('refuses the entry at once when the session changes during the check', async () => {
        const harness = createHarness('room-r', (current) => {
            current.session = { sessionId: 'bob-session', clientId: 'bob' };
            return undefined;
        });
        let changed = false;

        await expect(changeRelicRoom(harness.dependencies, async () => {
            changed = true;
        }, 'room-t')).rejects.toThrow(ROOM_ENTRY_CHANGED);
        expect(changed).toBe(false);
        expect(harness.locks).toEqual(['room-r:alice-session']);
    });

    it('checks a room that became current during the check under its own lock', async () => {
        const unfinished = createTimedOutRoundSnapshots().timedOut;
        const harness = createHarness('room-r', (current, roomId) => {
            current.currentRoomId = 'room-s';
            return roomId === 'room-s' ? unfinished : undefined;
        });

        await expect(changeRelicRoom(harness.dependencies, async () => 'entered', 'room-r')).rejects.toThrow(UNFINISHED_EXPEDITION);
        expect(harness.locks).toEqual(['room-r:alice-session', 'room-s:alice-session']);
        expect(harness.snapshotReads).toEqual(['room-r', 'room-s']);
    });

    it('still refuses an implicit leave of an unfinished expedition', async () => {
        const harness = createHarness('room-r', () => createTimedOutRoundSnapshots().timedOut);
        let changed = false;

        await expect(changeRelicRoom(harness.dependencies, async () => {
            changed = true;
        }, 'room-t')).rejects.toThrow(UNFINISHED_EXPEDITION);
        expect(changed).toBe(false);
    });

    it('enters when the last followed room move releases the session', async () => {
        let rooms = 0;
        const harness = createHarness('room-0', (current) => {
            rooms += 1;
            current.currentRoomId = rooms < 3 ? `room-${rooms}` : undefined;
            return undefined;
        });

        await expect(changeRelicRoom(harness.dependencies, async () => 'entered', 'room-t')).resolves.toBe('entered');
        expect(harness.locks).toEqual(['room-0:alice-session', 'room-1:alice-session', 'room-2:alice-session']);
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
        }, 'room-t')).rejects.toThrow(ROOM_ENTRY_CHANGED);
        expect(changed).toBe(false);
        expect(harness.locks).toEqual(['room-0:alice-session', 'room-1:alice-session', 'room-2:alice-session']);
    });
});
