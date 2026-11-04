import type { SelectedViewWatch } from '@shared-web/browser/api/selected-view-watch.ts';
import type { RallarRoomEntry } from '@shared-web/browser/rooms/entry/rallar-room-entry.ts';
import { RallarScheduledSessions } from '@shared-web/browser/rooms/sessions/rallar-scheduled-sessions.ts';
import type { RallarAuthState } from '@shared-web/browser/session/rallar-auth-facade.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { toGroupSessionTiming, type GroupSessionPage, type GroupSessionPreview } from '@shared/api/group-sessions/group-session-schedule.ts';
import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

const scope = { applicationId: 'game', workspaceId: 'default' };
const ref = { ...scope, groupId: 'friday' };
const schedule = { revision: 1, startsAtEpochMs: 3_600_000, cancelledAtEpochMs: null };
const preview: GroupSessionPreview = {
    roomRef: ref,
    displayName: 'Friday',
    schedule,
    timing: toGroupSessionTiming(schedule, 1_000),
    serverNowEpochMs: 1_000,
    maxPlayers: 4,
    availableSeats: 3,
    participation: 'none',
    isOrganizer: false,
    canReserve: true,
    canEnter: false,
    admissionDenial: null
};
const alice: AuthSession = { clientId: 'alice', sessionId: 'alice-session', username: 'alice', accessToken: 'test', expiresAtEpochMs: 9_999_999_999_999 };
const cleanups: (() => void)[] = [];
afterEach(() => {
    cleanups.splice(0).forEach((cleanup) => cleanup());
    vi.useRealTimers();
});

interface ScheduleTestApi {
    readonly list: Mock<RallarScheduledSessions.Api['list']>;
    readonly read: Mock<RallarScheduledSessions.Api['read']>;
    readonly create: Mock<RallarScheduledSessions.Api['create']>;
    readonly change: Mock<RallarScheduledSessions.Api['change']>;
}
interface ScheduleTestWatch {
    readonly select: Mock<SelectedViewWatch['select']>;
    readonly release: Mock<SelectedViewWatch['release']>;
}
function createScheduleTestApi(): ScheduleTestApi {
    return {
        list: vi.fn(() => Promise.resolve({ sessions: [preview], nextKey: null })),
        read: vi.fn(() => Promise.resolve(preview)),
        create: vi.fn(() => Promise.resolve(ref)),
        change: vi.fn(() => Promise.resolve())
    };
}

class ScheduleBrowserFixture {
    readonly owner: RallarScheduledSessions;
    readonly api = createScheduleTestApi();
    readonly watch: ScheduleTestWatch = {
        select: vi.fn(() => Promise.resolve()),
        release: vi.fn(() => Promise.resolve())
    };
    private session: AuthSession | undefined = alice;
    private active = true;
    private entryState: RallarRoomEntry.State = { status: 'idle', destination: null, principalId: null, failure: null };
    private readonly changes = new SynchronousNotifications<void>((error) => {
        throw error;
    });
    private readonly activity = new SynchronousNotifications<void>((error) => {
        throw error;
    });
    private readonly authChanges = new SynchronousNotifications<RallarAuthState>((error) => {
        throw error;
    });
    private readonly entryChanges = new SynchronousNotifications<RallarRoomEntry.State>((error) => {
        throw error;
    });
    readonly enter = vi.fn((destination: RallarRoomEntry.DestinationInput) => {
        this.entryState = {
            status: 'pending',
            destination: { ...destination, preserveCurrentMembership: destination.preserveCurrentMembership ?? false },
            principalId: null,
            failure: null
        };
        this.entryChanges.publishLatest(this.entryState);
        return this.entryState;
    });
    readonly enterScheduledLobby = vi.fn(() => this.entryState);

    constructor() {
        this.owner = new RallarScheduledSessions({
            auth: { session: () => this.session, onChange: (listener) => this.authChanges.subscribe(listener).unsubscribe },
            entry: {
                getState: () => this.entryState,
                onChange: (listener) => this.entryChanges.subscribe(listener).unsubscribe,
                enter: this.enter,
                enterScheduledLobby: this.enterScheduledLobby
            },
            api: this.api,
            activity: { isActive: () => this.active, onChange: (listener) => this.activity.subscribe(listener).unsubscribe },
            watch: this.watch,
            readConnectionGeneration: () => Promise.resolve('connection-1'),
            onChanged: (listener) => this.changes.subscribe(listener).unsubscribe,
            timers: createDefaultTimers(),
            createId: () => crypto.randomUUID()
        }, { scope });
        cleanups.push(() => this.owner.stop());
    }

    notifyChange(): void {
        this.changes.publishLatest(undefined);
    }

    changeActivity(value: boolean): void {
        this.active = value;
        this.activity.publishLatest(undefined);
    }

    changeAuth(next: AuthSession | undefined): void {
        this.session = next;
        this.authChanges.publishLatest({ authenticated: next !== undefined, reason: next ? 'login' : 'logout', session: next });
    }
}

describe('scheduled-session browser ownership', () => {
    it('does not poll and refreshes from a scoped notification or foreground restoration', async () => {
        vi.useFakeTimers();
        const test = new ScheduleBrowserFixture();
        await test.owner.start();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(test.api.list).toHaveBeenCalledOnce();
        const changed = { ...preview, displayName: 'Changed elsewhere' };
        test.api.list.mockResolvedValue({ sessions: [changed], nextKey: null });
        test.changeActivity(false);
        test.notifyChange();
        await vi.advanceTimersByTimeAsync(100);
        expect(test.api.list).toHaveBeenCalledOnce();
        test.changeActivity(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(test.owner.getState().sessions).toEqual([changed]);
        test.api.list.mockResolvedValue({ sessions: [], nextKey: null });
        test.notifyChange();
        await vi.advanceTimersByTimeAsync(0);
        expect(test.owner.getState().sessions).toEqual([]);
    });

    it('registers the selected preview before reading its canonical state', async () => {
        const test = new ScheduleBrowserFixture();
        await test.owner.start();
        const registered = Promise.withResolvers<void>();
        const started = Promise.withResolvers<void>();
        test.watch.select.mockImplementationOnce(() => {
            started.resolve();
            return registered.promise;
        });
        const selecting = test.owner.select(ref);
        await started.promise;
        expect(test.api.read).not.toHaveBeenCalled();
        registered.resolve();
        await selecting;
        expect(test.owner.getState().selected).toEqual(preview);
        expect(test.watch.select).toHaveBeenCalledWith(expect.objectContaining({ resourceId: ref.groupId, session: alice }));
    });

    it('reads server authority once when the observed lobby boundary is reached', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const test = new ScheduleBrowserFixture();
        test.api.list.mockImplementation(() =>
            Promise.resolve({
                sessions: [{ ...preview, timing: toGroupSessionTiming(schedule, Date.now()), serverNowEpochMs: Date.now() }],
                nextKey: null
            })
        );
        await test.owner.start();
        await vi.advanceTimersByTimeAsync(2_999_000);
        expect(test.api.list).toHaveBeenCalledTimes(2);
        expect(test.owner.getState().sessions[0]?.timing.phase).toBe('lobby');
    });

    it('does not postpone the lobby boundary when a local command fails just before it', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const test = new ScheduleBrowserFixture();
        await test.owner.start();
        await test.owner.select(ref);
        await vi.advanceTimersByTimeAsync(2_998_000);
        test.api.change.mockRejectedValueOnce(new Error('Response lost'));
        await test.owner.act('reserve');
        const fresh = { ...preview, timing: toGroupSessionTiming(schedule, 3_000_000), serverNowEpochMs: 3_000_000 };
        test.api.list.mockResolvedValue({ sessions: [fresh], nextKey: null });
        test.api.read.mockResolvedValue(fresh);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(test.owner.getState().selected?.timing.phase).toBe('lobby');
    });

    it('keeps personal sessions current when the selected preview can no longer be watched', async () => {
        const test = new ScheduleBrowserFixture();
        await test.owner.start();
        await test.owner.select(ref);
        test.watch.select.mockRejectedValue(new Error('Preview no longer exists'));
        const other = { ...preview, roomRef: { ...ref, groupId: 'another' } };
        test.api.list.mockResolvedValue({ sessions: [other], nextKey: null });
        await test.owner.refresh();
        expect(test.owner.getState()).toMatchObject({ sessions: [other], selected: null, error: 'Preview no longer exists' });
    });

    it('does not shift a received page deadline while preview registration is waiting', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(2_999_000);
        const test = new ScheduleBrowserFixture();
        test.api.list.mockResolvedValueOnce({ sessions: [], nextKey: null }).mockImplementation(() =>
            Promise.resolve({
                sessions: [{ ...preview, timing: toGroupSessionTiming(schedule, Date.now()), serverNowEpochMs: Date.now() }],
                nextKey: null
            })
        );
        await test.owner.start();
        const registered = Promise.withResolvers<void>();
        const started = Promise.withResolvers<void>();
        test.watch.select.mockImplementationOnce(() => {
            started.resolve();
            return registered.promise;
        });
        const selecting = test.owner.select(ref);
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(10_000);
        registered.resolve();
        await selecting;
        await vi.advanceTimersByTimeAsync(0);
        expect(test.owner.getState().sessions[0]?.timing.phase).toBe('lobby');
    });

    it('covers a notification received while a personal directory read is in flight', async () => {
        const test = new ScheduleBrowserFixture();
        await test.owner.start();
        const entered = Promise.withResolvers<void>();
        const delayed = Promise.withResolvers<GroupSessionPage>();
        test.api.list.mockImplementationOnce(() => {
            entered.resolve();
            return delayed.promise;
        });
        const first = test.owner.refresh();
        await entered.promise;
        const updated = { ...preview, displayName: 'Rescheduled Friday' };
        test.api.list.mockResolvedValue({ sessions: [updated], nextKey: null });
        const covering = test.owner.refresh();
        delayed.resolve({ sessions: [preview], nextKey: null });
        await Promise.all([first, covering]);
        expect(test.owner.getState().sessions).toEqual([updated]);
    });

    it('loads personal sessions and previews without entering gameplay', async () => {
        const test = new ScheduleBrowserFixture();
        await test.owner.start();
        await test.owner.select(ref);
        expect(test.owner.getState()).toMatchObject({ sessions: [preview], selected: preview, error: null });
        expect(test.enter).toHaveBeenCalledWith({ intent: 'preview-session', roomRef: ref, joinCode: null, participation: 'player' });
        expect(test.enterScheduledLobby).not.toHaveBeenCalled();
        await test.owner.enterLobby();
        expect(test.enterScheduledLobby).not.toHaveBeenCalled();
        test.api.read.mockResolvedValue({ ...preview, timing: toGroupSessionTiming(schedule, 3_000_000), serverNowEpochMs: 3_000_000, canEnter: true });
        await test.owner.enterLobby();
        expect(test.enterScheduledLobby).toHaveBeenCalled();
    });

    it('ignores old account reads even when their transport ignores abort', async () => {
        const test = new ScheduleBrowserFixture();
        const delayed = Promise.withResolvers<GroupSessionPage>();
        const entered = Promise.withResolvers<void>();
        test.api.list.mockImplementationOnce(() => {
            entered.resolve();
            return delayed.promise;
        }).mockResolvedValue({ sessions: [], nextKey: null });
        const first = test.owner.start();
        await entered.promise;
        test.changeAuth({ ...alice, clientId: 'bob', sessionId: 'bob-session' });
        await test.owner.refresh();
        delayed.resolve({ sessions: [preview], nextKey: null });
        await first;
        expect(test.owner.getState().sessions).toEqual([]);
    });

    it.each(['destination', 'account'] as const)('does not enter a replacement %s after an old admission refresh finishes', async (replacement) => {
        const test = new ScheduleBrowserFixture();
        test.api.read.mockImplementation((roomRef) => Promise.resolve({ ...preview, roomRef, canEnter: true }));
        await test.owner.start();
        await test.owner.select(ref);
        const delayed = Promise.withResolvers<GroupSessionPage>();
        const entered = Promise.withResolvers<void>();
        test.api.list.mockImplementationOnce(() => {
            entered.resolve();
            return delayed.promise;
        });
        const entering = test.owner.enterLobby();
        await entered.promise;
        if (replacement === 'account') {
            test.changeAuth({ ...alice, clientId: 'bob', sessionId: 'bob-session' });
        }
        await test.owner.select({ ...ref, groupId: 'replacement' });
        expect(test.owner.getState().selected?.roomRef.groupId).toBe('replacement');
        delayed.resolve({ sessions: [preview], nextKey: null });
        await entering;
        expect(test.enterScheduledLobby).not.toHaveBeenCalled();
    });

    it('clears stale admission permission when its current refresh fails', async () => {
        const test = new ScheduleBrowserFixture();
        test.api.read.mockResolvedValue({ ...preview, canEnter: true });
        await test.owner.start();
        await test.owner.select(ref);
        test.api.read.mockRejectedValueOnce(new Error('Preview unavailable'));
        await test.owner.enterLobby();
        expect(test.owner.getState()).toMatchObject({ selected: null, error: 'Preview unavailable' });
        expect(test.enterScheduledLobby).not.toHaveBeenCalled();
    });

    it('retains loaded pages across refresh and rejects foreign room selection', async () => {
        const test = new ScheduleBrowserFixture();
        const second = { ...preview, roomRef: { ...ref, groupId: 'second' } };
        test.api.list.mockImplementation(({ after }) =>
            Promise.resolve(
                after === null ? { sessions: [preview], nextKey: 'page-two' } : { sessions: [second], nextKey: null }
            )
        );
        await test.owner.start();
        await test.owner.loadMore();
        await test.owner.refresh();
        expect(test.owner.getState().sessions).toEqual([preview, second]);
        await expect(test.owner.select({ ...ref, workspaceId: 'other' })).rejects.toThrow('scope');
    });

    it('retries an ambiguous write with the same identity and reviewed revision', async () => {
        const test = new ScheduleBrowserFixture();
        await test.owner.start();
        await test.owner.select(ref);
        test.api.change.mockRejectedValueOnce(new Error('Response lost'));
        await test.owner.act('reserve');
        expect(test.owner.getState()).toMatchObject({ retryPending: true, busy: false });
        await test.owner.retry();
        expect(test.api.change).toHaveBeenCalledTimes(2);
        expect(test.api.change.mock.calls[0]?.[0].request).toEqual(test.api.change.mock.calls[1]?.[0].request);
        expect(test.api.change.mock.calls[1]?.[0].request).toMatchObject({ action: 'reserve', expectedScheduleRevision: 1 });
        expect(test.owner.getState().retryPending).toBe(false);
    });

    it('deduplicates creation clicks and does not select the created room after logout', async () => {
        const test = new ScheduleBrowserFixture();
        await test.owner.start();
        const delayed = Promise.withResolvers<typeof ref>();
        test.api.create.mockReturnValue(delayed.promise);
        const input = { displayName: 'Friday', startsAtEpochMs: 3_600_000, maxPlayers: 4 };
        const first = test.owner.create(input);
        await test.owner.create(input);
        expect(test.api.create).toHaveBeenCalledOnce();
        test.changeAuth(undefined);
        delayed.resolve(ref);
        await first;
        expect(test.enter).not.toHaveBeenCalled();
        expect(test.owner.getState()).toMatchObject({ sessions: [], selected: null, busy: false });
    });
});
