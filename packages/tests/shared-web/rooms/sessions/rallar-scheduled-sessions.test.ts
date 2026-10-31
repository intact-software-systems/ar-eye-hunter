import type { RallarRoomEntry } from '@shared-web/browser/rooms/entry/rallar-room-entry.ts';
import { RallarScheduledSessions } from '@shared-web/browser/rooms/sessions/rallar-scheduled-sessions.ts';
import type { RallarAuthState } from '@shared-web/browser/session/rallar-auth-facade.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { toGroupSessionTiming, type GroupSessionPage, type GroupSessionPreview } from '@shared/api/group-sessions/group-session-schedule.ts';
import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function browser() {
    let session: AuthSession | undefined = alice;
    let entryState: RallarRoomEntry.State = { status: 'idle', destination: null, principalId: null, failure: null };
    const authChanges = new SynchronousNotifications<RallarAuthState>((error) => {
        throw error;
    });
    const entryChanges = new SynchronousNotifications<RallarRoomEntry.State>((error) => {
        throw error;
    });
    const api = {
        list: vi.fn<RallarScheduledSessions.Api['list']>(async () => ({ sessions: [preview], nextKey: null })),
        read: vi.fn<RallarScheduledSessions.Api['read']>(async () => preview),
        create: vi.fn<RallarScheduledSessions.Api['create']>(async () => ref),
        change: vi.fn<RallarScheduledSessions.Api['change']>(async () => {})
    };
    const enter = vi.fn((destination: RallarRoomEntry.Destination) => {
        entryState = { status: 'pending', destination, principalId: null, failure: null };
        entryChanges.publishLatest(entryState);
        return entryState;
    });
    const enterScheduledLobby = vi.fn(() => entryState);
    const owner = new RallarScheduledSessions({
        auth: { session: () => session, onChange: (listener) => authChanges.subscribe(listener).unsubscribe },
        entry: { getState: () => entryState, onChange: (listener) => entryChanges.subscribe(listener).unsubscribe, enter, enterScheduledLobby },
        api,
        timers: createDefaultTimers(),
        createId: () => crypto.randomUUID()
    }, { scope, refreshIntervalMs: 30_000 });
    cleanups.push(() => owner.stop());
    return {
        owner,
        api,
        enter,
        enterScheduledLobby,
        changeAuth(next: AuthSession | undefined) {
            session = next;
            authChanges.publishLatest({ authenticated: next !== undefined, reason: next ? 'login' : 'logout', session: next });
        }
    };
}

describe('scheduled-session browser ownership', () => {
    it('loads personal sessions and previews without entering gameplay', async () => {
        const test = browser();
        await test.owner.start();
        await test.owner.select(ref);
        expect(test.owner.getState()).toMatchObject({ sessions: [preview], selected: preview, error: null });
        expect(test.enter).toHaveBeenCalledWith({ intent: 'preview-session', roomRef: ref, joinCode: null, participation: 'player' });
        expect(test.enterScheduledLobby).not.toHaveBeenCalled();
        await test.owner.enterLobby();
        expect(test.enterScheduledLobby).not.toHaveBeenCalled();
        test.api.read.mockResolvedValue({ ...preview, timing: toGroupSessionTiming(schedule, 3_000_000), serverNowEpochMs: 3_000_000, canEnter: true });
        await test.owner.enterLobby();
        expect(test.enterScheduledLobby).toHaveBeenCalledOnce();
    });

    it('ignores old account reads even when their transport ignores abort', async () => {
        const test = browser();
        const delayed = Promise.withResolvers<GroupSessionPage>();
        test.api.list.mockReturnValueOnce(delayed.promise).mockResolvedValue({ sessions: [], nextKey: null });
        const first = test.owner.start();
        test.changeAuth({ ...alice, clientId: 'bob', sessionId: 'bob-session' });
        await test.owner.refresh();
        delayed.resolve({ sessions: [preview], nextKey: null });
        await first;
        expect(test.owner.getState().sessions).toEqual([]);
    });

    it.each(['destination', 'account'] as const)('does not enter a replacement %s after an old admission refresh finishes', async (replacement) => {
        const test = browser();
        test.api.read.mockImplementation(async (roomRef) => ({ ...preview, roomRef, canEnter: true }));
        await test.owner.start();
        await test.owner.select(ref);
        const delayed = Promise.withResolvers<GroupSessionPage>();
        test.api.list.mockReturnValueOnce(delayed.promise);
        const entering = test.owner.enterLobby();
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
        const test = browser();
        test.api.read.mockResolvedValue({ ...preview, canEnter: true });
        await test.owner.start();
        await test.owner.select(ref);
        test.api.read.mockRejectedValueOnce(new Error('Preview unavailable'));
        await test.owner.enterLobby();
        expect(test.owner.getState()).toMatchObject({ selected: null, error: 'Preview unavailable' });
        expect(test.enterScheduledLobby).not.toHaveBeenCalled();
    });

    it('retains loaded pages across refresh and rejects foreign room selection', async () => {
        const test = browser();
        const second = { ...preview, roomRef: { ...ref, groupId: 'second' } };
        test.api.list.mockImplementation(async ({ after }) =>
            after === null
                ? { sessions: [preview], nextKey: 'page-two' }
                : { sessions: [second], nextKey: null }
        );
        await test.owner.start();
        await test.owner.loadMore();
        await test.owner.refresh();
        expect(test.owner.getState().sessions).toEqual([preview, second]);
        await expect(test.owner.select({ ...ref, workspaceId: 'other' })).rejects.toThrow('scope');
    });

    it('retries an ambiguous write with the same identity and reviewed revision', async () => {
        const test = browser();
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
        const test = browser();
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
