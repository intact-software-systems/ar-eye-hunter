import { RallarRoomMove } from '@shared-web/browser/rooms/move/rallar-room-move.ts';
import type { RallarAuthState } from '@shared-web/browser/session/rallar-auth-facade.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupMove, GroupMoveRequest } from '@shared/api/mutation/group-move.ts';
import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
    type Mock
} from 'vitest';

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
    active(value: boolean): void;
}

function moveAuthentication() {
    let current: AuthSession | undefined = session;
    const events = new SynchronousNotifications<RallarAuthState>((error) => {
        throw error;
    });
    const unsubscribe = vi.fn(() => {});
    const auth: RallarRoomMove.Auth = {
        session: () => current,
        onChange(listener) {
            const subscription = events.subscribe(listener);
            return () => {
                subscription.unsubscribe();
                unsubscribe();
            };
        }
    };
    return {
        auth,
        unsubscribe,
        change(next: AuthSession | undefined) {
            current = next;
            events.publishLatest({ authenticated: next !== undefined, session: next, reason: next ? 'login' : 'logout' });
        }
    };
}

function browser(): RoomMoveBrowser {
    let current = { ...source, displayName: 'Source room' };
    let blocker: string | null = null;
    let active = true;
    const activity = new SynchronousNotifications<void>((error) => {
        throw error;
    });
    const changed = new SynchronousNotifications<void>((error) => {
        throw error;
    });
    const authentication = moveAuthentication();
    const api = createMoveApi();
    const refreshRooms = vi.fn(async () => {});
    const owner = new RallarRoomMove({
        auth: authentication.auth,
        activity: { isActive: () => active, onChange: (listener) => activity.subscribe(listener).unsubscribe },
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
    }, { scope: source });
    cleanups.push(() => {
        owner.stop();
    });
    return {
        owner,
        api,
        refreshRooms,
        unsubscribeAuth: authentication.unsubscribe,
        currentRoom: () => current,
        selectRoom: (groupId: string) => {
            current = { ...current, groupId };
        },
        changeAuth: authentication.change,
        block: (reason: string | null) => {
            blocker = reason;
        },
        notify: () => changed.publishLatest(undefined),
        active(value) {
            active = value;
            activity.publishLatest();
        }
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
    it('keeps idle and hidden views quiet and recovers the latest move on foreground return', async () => {
        vi.useFakeTimers();
        cleanups.push(() => vi.useRealTimers());
        const b = browser();
        b.api.setMoves([]);
        await b.owner.start();
        await vi.advanceTimersByTimeAsync(60000);
        expect(b.api.list).toHaveBeenCalledTimes(1);
        b.active(false);
        b.api.setMoves([{ ...committed, status: 'cancelled', reason: 'organizer-cancelled' }]);
        b.notify();
        await vi.advanceTimersByTimeAsync(60000);
        expect(b.api.list).toHaveBeenCalledTimes(1);
        expect(b.owner.getState().moves).toEqual([]);
        b.active(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(b.owner.getState().moves[0]?.status).toBe('cancelled');
        expect(b.api.list).toHaveBeenCalledTimes(2);
        b.owner.stop();
        b.notify();
        b.active(false);
        b.active(true);
        await vi.advanceTimersByTimeAsync(60000);
        expect(b.api.list).toHaveBeenCalledTimes(2);
    });

    it('binds party selection through proposal, consent and arrival without changing game eligibility', async () => {
        const b = browser();
        b.api.setMoves([]);
        await b.owner.start();
        const party = { partyId: 'friends-party', rosterRevision: 3 };
        const proposal: GroupMove = {
            ...committed,
            party,
            status: 'proposed',
            completedAtEpochMs: null,
            participants: committed.participants.map((participant) => ({ ...participant, confirmedAtEpochMs: null }))
        };
        b.api.mutate.mockImplementation(async (request) => {
            b.api.commands.push(request);
            const result = { ...(request.action === 'propose' ? proposal : committed), moveId: request.moveId, party };
            b.api.setMoves([result]);
            return result;
        });
        await b.owner.propose(destination, party);
        await b.owner.act('confirm', b.owner.getState().moves[0]);
        expect(b.api.commands.find((command) => command.action === 'propose')?.party).toEqual(party);
        expect(b.api.commands.find((command) => command.action === 'confirm')?.party).toEqual(party);
        expect(b.api.commands.find((command) => command.action === 'arrive')?.party).toEqual(party);
        expect(b.currentRoom().groupId).toBe(destination.groupId);
    });

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

    it('defers hidden reads and fences the previous account across foreground recovery', async () => {
        vi.useFakeTimers();
        cleanups.push(() => vi.useRealTimers());
        const b = browser();
        b.active(false);
        await b.owner.start();
        expect(b.api.list).not.toHaveBeenCalled();
        const old = Promise.withResolvers<readonly GroupMove[]>();
        const started = Promise.withResolvers<void>();
        b.api.list.mockImplementationOnce(() => {
            started.resolve();
            return old.promise;
        });
        b.active(true);
        await started.promise;
        b.active(false);
        const bob = { ...session, clientId: 'bob', sessionId: 'bob-session' };
        b.changeAuth(bob);
        expect(b.owner.getState().moves).toEqual([]);
        b.api.setMoves([]);
        old.resolve([committed]);
        await vi.advanceTimersByTimeAsync(0);
        expect(b.api.list).not.toHaveBeenCalledWith(expect.anything(), bob, expect.anything());
        b.active(true);
        await vi.waitFor(() => expect(b.api.list).toHaveBeenCalledWith(expect.anything(), bob, expect.anything()));
        expect(b.currentRoom().groupId).toBe(source.groupId);
        expect(b.owner.getState().moves).toEqual([]);
    });

    it('defers a queued push read if the page hides before the read starts', async () => {
        const b = browser();
        b.api.setMoves([]);
        const started = Promise.withResolvers<void>();
        const held = Promise.withResolvers<readonly GroupMove[]>();
        b.api.list.mockImplementationOnce(() => {
            started.resolve();
            return held.promise;
        });
        const starting = b.owner.start();
        await started.promise;
        b.notify();
        b.active(false);
        b.api.setMoves([{ ...committed, status: 'cancelled', reason: 'organizer-cancelled' }]);
        held.resolve([]);
        await starting;
        expect(b.owner.getState().moves).toEqual([]);
        b.active(true);
        await vi.waitFor(() => expect(b.owner.getState().moves[0]?.status).toBe('cancelled'));
    });

    it('clears a recovered list error while retaining an actionable entry failure', async () => {
        const b = browser();
        b.api.list.mockRejectedValueOnce(new Error('Move history unavailable'));
        await b.owner.start();
        expect(b.owner.getState().error).toBe('Move history unavailable');
        b.api.setMoves([]);
        await b.owner.refresh();
        expect(b.owner.getState().error).toBeNull();
        b.block('Leave expedition first');
        b.api.setMoves([committed]);
        await b.owner.refresh();
        await b.owner.refresh();
        expect(b.owner.getState().error).toBe('Leave expedition first');
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
        b.unsubscribeAuth.mockImplementationOnce(() => {
            throw new Error('cleanup failure');
        });
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
