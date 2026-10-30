import { RallarRoomMove } from '@shared-web/browser/rooms/move/rallar-room-move.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupMove, GroupMoveRequest } from '@shared/api/mutation/group-move.ts';
import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

const source = { applicationId: 'game', workspaceId: 'default', groupId: 'source' };
const destination = { ...source, groupId: 'destination' };
const session: AuthSession = { clientId: 'alice', sessionId: 'alice-session', username: 'alice', accessToken: 'test', expiresAtEpochMs: 9999999999999 };
const committed: GroupMove = {
    moveId: 'move-1',
    source,
    destination,
    organizerSessionId: 'alice-session',
    participants: [{
        principalId: 'alice',
        sessionId: 'alice-session',
        generationId: 'generation',
        generationVersion: 100,
        confirmedAtEpochMs: 110,
        arrivedAtEpochMs: null
    }],
    createdAtEpochMs: 100,
    expiresAtEpochMs: 120100,
    completedAtEpochMs: 120,
    status: 'committed',
    reason: null,
    admissionFailure: null
};
const cleanups: (() => void)[] = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
        cleanup();
    }
});

interface MoveApi extends RallarRoomMove.Api {
    readonly commands: GroupMoveRequest[];
    readonly list: Mock<RallarRoomMove.Api['list']>;
    readonly mutate: Mock<RallarRoomMove.Api['mutate']>;
    setMoves(moves: readonly GroupMove[]): void;
}

interface RoomMoveBrowser {
    readonly owner: RallarRoomMove;
    readonly api: MoveApi;
    readonly refreshRooms: Mock<() => Promise<void>>;
    readonly unsubscribeAuth: Mock<() => void>;
    currentRoom(): typeof source;
    selectRoom(groupId: string): void;
    changeAuth(next: AuthSession | undefined): void;
    block(reason: string | null): void;
    notify(): void;
}

function browser(): RoomMoveBrowser {
    let auth: AuthSession | undefined = session;
    let current = { ...source, displayName: 'Source room' };
    let blocker: string | null = null;
    const changed = new SynchronousNotifications<void>((error) => {
        throw error;
    });
    const api = createMoveApi();
    const unsubscribeAuth = vi.fn(() => {});
    const refreshRooms = vi.fn(async () => {});
    const owner = new RallarRoomMove({
        auth: { session: () => auth, onChange: () => unsubscribeAuth },
        currentRoom: () => current,
        activate: async () => {
            current = { ...destination, displayName: 'Destination room' };
        },
        refreshRooms,
        api,
        onChanged: (listener) => changed.subscribe(listener).unsubscribe,
        withEligibility: async (_destination, run) => {
            if (blocker) {
                throw new Error(blocker);
            }
            return await run();
        },
        timers: createDefaultTimers()
    }, { scope: source, refreshIntervalMs: 30000 });
    cleanups.push(() => {
        owner.stop();
    });
    return {
        owner,
        api,
        refreshRooms,
        unsubscribeAuth,
        currentRoom: () => current,
        selectRoom: (groupId: string) => {
            current = { ...current, groupId };
        },
        changeAuth: (next: AuthSession | undefined) => {
            auth = next;
        },
        block: (reason: string | null) => {
            blocker = reason;
        },
        notify: () => changed.publishLatest(undefined)
    };
}

function createMoveApi(): MoveApi {
    let moves: readonly GroupMove[] = [committed];
    const commands: GroupMoveRequest[] = [];
    return {
        commands,
        setMoves: (next: readonly GroupMove[]) => {
            moves = next;
        },
        list: vi.fn<RallarRoomMove.Api['list']>(async () => moves),
        mutate: vi.fn<RallarRoomMove.Api['mutate']>(async (request) => {
            commands.push(request);
            if (request.action === 'arrive') {
                moves = [{ ...committed, participants: committed.participants.map((p) => ({ ...p, arrivedAtEpochMs: 130 })) }];
                return moves[0];
            }
            return committed;
        })
    };
}

describe('Move together browser lifecycle', () => {
    it('recovers the durable destination without browser storage and reports arrival only after activation', async () => {
        const b = browser();
        await b.owner.start();
        expect(b.currentRoom().groupId).toBe(destination.groupId);
        expect(b.api.commands.map((command) => command.action)).toEqual(['arrive']);
        expect(b.owner.getState().moves[0].participants[0].arrivedAtEpochMs).toBe(130);
    });

    it('keeps committed admission visible when game eligibility blocks activation and supports explicit retry', async () => {
        const b = browser();
        b.block('Leave expedition first');
        await b.owner.start();
        expect(b.currentRoom().groupId).toBe(source.groupId);
        expect(b.api.commands).toEqual([]);
        expect(b.owner.getState()).toMatchObject({ error: 'Leave expedition first', moves: [committed] });
        b.block(null);
        await b.owner.enter(committed);
        expect(b.owner.getState().moves[0].participants[0].arrivedAtEpochMs).toBe(130);
    });

    it('does not enter or publish a stale result when authentication changes during recovery', async () => {
        const b = browser();
        b.api.list.mockImplementationOnce(async () => {
            b.changeAuth({ ...session, sessionId: 'replacement' });
            return [committed];
        });
        await b.owner.start();
        expect(b.currentRoom().groupId).toBe(source.groupId);
        expect(b.owner.getState().moves).toEqual([]);
    });

    it('sends only the scoped room identity from a richer current-room snapshot', async () => {
        const b = browser();
        b.api.setMoves([]);
        await b.owner.start();
        await b.owner.propose(destination);
        expect(b.api.commands[0].source).toEqual(source);
    });

    it('re-reads a notification that arrives while the preceding read is in flight', async () => {
        const b = browser();
        b.api.setMoves([]);
        const reading = Promise.withResolvers<void>();
        let release: (moves: readonly GroupMove[]) => void = () => {};
        b.api.list.mockImplementationOnce(() =>
            new Promise((resolve) => {
                release = resolve;
                reading.resolve();
            })
        );
        const started = b.owner.start();
        await reading.promise;
        b.api.setMoves([{ ...committed, status: 'proposed', completedAtEpochMs: null }]);
        b.notify();
        release([]);
        await started;
        expect(b.owner.getState().moves[0]?.status).toBe('proposed');
    });

    it.each([0, 1, 2, 3, 4, 5, 6, 7])('observes a refresh requested during read settlement at microtask offset %i', async (offset) => {
        const b = browser();
        const pending: GroupMove = { ...committed, status: 'proposed', completedAtEpochMs: null };
        const refreshed = Promise.withResolvers<void>();
        b.api.list.mockImplementationOnce(async () => {
            afterMicrotasks(offset, () => {
                b.api.setMoves([pending]);
                b.owner.refresh().then(refreshed.resolve, refreshed.reject);
            });
            return [];
        });
        await b.owner.start();
        await refreshed.promise;
        expect(b.owner.getState().moves).toEqual([pending]);
    });

    it('aborts and isolates the previous session even when subscription cleanup throws', async () => {
        const b = browser();
        const pending: GroupMove = { ...committed, status: 'proposed', completedAtEpochMs: null };
        b.api.setMoves([pending]);
        await b.owner.start();
        const reading = Promise.withResolvers<AbortSignal>();
        const oldRead = Promise.withResolvers<readonly GroupMove[]>();
        b.api.list.mockImplementationOnce(async (_scope, _session, signal) => {
            reading.resolve(signal);
            return await oldRead.promise;
        });
        const refreshing = b.owner.refresh();
        const signal = await reading.promise;
        b.unsubscribeAuth.mockImplementationOnce(() => { throw new Error('cleanup failure'); });
        expect(() => b.owner.stop()).toThrow(AggregateError);
        expect(signal.aborted).toBe(true);
        expect(b.owner.getState()).toEqual({ moves: [], busy: false, enteringMoveId: null, error: null });
        b.api.setMoves([pending]);
        await b.owner.start();
        oldRead.resolve([]);
        await refreshing;
        expect(b.owner.getState().moves).toEqual([pending]);
    });

    it('keeps the current proposal readable when refreshing an older room is forbidden', async () => {
        const b = browser();
        const pending: GroupMove = { ...committed, moveId: 'pending', status: 'proposed', completedAtEpochMs: null };
        const old: GroupMove = { ...committed, participants: committed.participants.map((participant) => ({ ...participant, arrivedAtEpochMs: 130 })) };
        b.api.setMoves([pending, old]);
        b.refreshRooms.mockRejectedValue(new Error('Old room access was revoked'));
        await b.owner.start();
        expect(b.owner.getState().moves).toEqual([pending, old]);
        await b.owner.act('confirm', pending);
        expect(b.api.commands[0]).toMatchObject({ action: 'confirm', moveId: 'pending' });
    });

    it('blocks confirmation before sending when the game becomes ineligible', async () => {
        const b = browser();
        b.api.setMoves([]);
        await b.owner.start();
        b.block('Finish the match first');
        await b.owner.act('confirm', { ...committed, status: 'proposed', completedAtEpochMs: null });
        expect(b.api.commands).toEqual([]);
        expect(b.owner.getState().error).toBe('Finish the match first');
    });

    it('does not automatically pull a participant back from another room for an old committed move', async () => {
        const b = browser();
        await b.owner.start();
        b.selectRoom('third-room');
        b.api.setMoves([committed]);
        await b.owner.refresh();
        expect(b.currentRoom().groupId).toBe('third-room');
    });
});

function afterMicrotasks(remaining: number, run: () => void): void {
    queueMicrotask(() => {
        if (remaining > 0) {
            afterMicrotasks(remaining - 1, run);
        }
        else {
            run();
        }
    });
}
