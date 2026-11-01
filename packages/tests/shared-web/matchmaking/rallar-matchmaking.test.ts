import { RallarMatchmaking } from '@shared-web/browser/matchmaking/rallar-matchmaking.ts';
import type { RallarAuthState } from '@shared-web/browser/session/rallar-auth-facade.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { MatchmakingSnapshot } from '@shared/api/matchmaking/matchmaking-snapshot.ts';
import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

const alice: AuthSession = { clientId: 'alice', username: 'alice', sessionId: 'alice-session', accessToken: 'test', expiresAtEpochMs: 9999999999999 };
const scope = { applicationId: 'game', workspaceId: 'default' };
const confirming: MatchmakingSnapshot['state'] = {
    status: 'confirming',
    searchId: 'alice-search',
    expiresAtEpochMs: 30000,
    leaderPrincipalId: 'alice',
    players: [{ principalId: 'alice', confirmed: false }, { principalId: 'bob', confirmed: false }]
};
const matched: MatchmakingSnapshot['state'] = {
    status: 'matched',
    searchId: 'alice-search',
    leaderPrincipalId: 'alice',
    roomRef: { ...scope, groupId: 'match-room' }
};
const cleanups: (() => void)[] = [];
afterEach(() => {
    cleanups.splice(0).forEach((cleanup) => cleanup());
    vi.useRealTimers();
});

function browser() {
    let session: AuthSession | undefined = alice;
    let active = true;
    const auth = new SynchronousNotifications<RallarAuthState>((error) => {
        throw error;
    });
    const activity = new SynchronousNotifications<void>((error) => {
        throw error;
    });
    const api = {
        read: vi.fn<RallarMatchmaking.Api['read']>(async ({ session }) => ({
            scope,
            principalId: session.clientId,
            observedAtEpochMs: 1000,
            state: { status: 'idle' }
        })),
        change: vi.fn<RallarMatchmaking.Api['change']>(async ({ request, requestId, session }) => ({
            scope,
            principalId: session.clientId,
            requestId,
            status: 'applied',
            searchId: request.searchId,
            code: null
        }))
    };
    const enter = vi.fn();
    const owner = new RallarMatchmaking({
        auth: { session: () => session, onChange: (listener) => auth.subscribe(listener).unsubscribe },
        activity: { isActive: () => active, onChange: (listener) => activity.subscribe(listener).unsubscribe },
        api,
        entry: { enter },
        timers: createDefaultTimers(),
        createId: () => crypto.randomUUID()
    }, { scope, refreshIntervalMs: 1000 });
    cleanups.push(() => owner.stop());
    return {
        owner,
        api,
        enter,
        state(state: MatchmakingSnapshot['state']) {
            api.read.mockImplementation(async ({ session }) => ({ scope, principalId: session.clientId, observedAtEpochMs: 1000, state }));
        },
        login(next: AuthSession | undefined) {
            session = next;
            auth.publishLatest({ authenticated: next !== undefined, reason: next ? 'login' : 'logout', session: next });
        },
        active(next: boolean) {
            active = next;
            activity.publishLatest();
        }
    };
}

describe('matchmaking browser recovery and consent', () => {
    it('recovers confirmation, binds commands to the recovered search, and enters only a committed destination', async () => {
        const test = browser();
        test.state(confirming);
        await test.owner.start();
        await test.owner.enter();
        expect(test.enter).not.toHaveBeenCalled();
        await test.owner.confirm();
        expect(test.api.change.mock.calls[0]?.[0].request).toEqual({ action: 'confirm', searchId: 'alice-search' });
        test.state(matched);
        await test.owner.refresh();
        expect(test.owner.getState().snapshot?.state).toEqual(matched);
        await test.owner.enter();
        expect(test.enter).toHaveBeenCalledWith({ intent: 'join', roomRef: matched.roomRef, joinCode: null, participation: 'player' });
    });

    it('keeps the exact command after an ambiguous response and blocks a replacement search until retry resolves', async () => {
        const test = browser();
        await test.owner.start();
        test.api.change.mockRejectedValueOnce(new Error('Response lost'));
        await test.owner.find();
        const first = test.api.change.mock.calls[0]![0];
        expect(test.owner.getState()).toMatchObject({ retryPending: true, busy: false, error: 'Response lost' });
        await test.owner.find();
        await test.owner.cancel();
        expect(test.api.change).toHaveBeenCalledTimes(1);
        await test.owner.retry();
        expect(test.api.change.mock.calls[1]?.[0]).toEqual(first);
        expect(test.owner.getState()).toMatchObject({ retryPending: false, busy: false, error: null });
    });

    it('never requeues a timed-out cohort and uses a new identity only after an explicit new search', async () => {
        vi.useFakeTimers();
        const test = browser();
        test.state(confirming);
        await test.owner.start();
        await test.owner.cancel();
        expect(test.api.change.mock.calls[0]?.[0].request).toEqual({ action: 'cancel', searchId: 'alice-search' });
        test.state({ status: 'ended', searchId: 'alice-search', reason: 'confirmation-timeout' });
        await vi.advanceTimersByTimeAsync(3000);
        expect(test.owner.getState().snapshot?.state).toMatchObject({ status: 'ended', reason: 'confirmation-timeout' });
        expect(test.api.change).toHaveBeenCalledTimes(1);
        await test.owner.find();
        expect(test.api.change.mock.calls[1]?.[0].request.action).toBe('start');
        expect(test.api.change.mock.calls[1]?.[0].request.searchId).not.toBe('alice-search');
    });

    it('discards late reads after login replacement and clears pending consent on logout', async () => {
        const test = browser();
        const late = Promise.withResolvers<MatchmakingSnapshot>();
        test.api.read.mockReturnValueOnce(late.promise);
        const start = test.owner.start();
        test.login({ ...alice, clientId: 'bob', sessionId: 'bob-session' });
        await test.owner.refresh();
        late.resolve({ scope, principalId: 'alice', observedAtEpochMs: 1000, state: confirming });
        await start;
        expect(test.owner.getState().snapshot?.principalId).toBe('bob');
        test.api.change.mockRejectedValueOnce(new Error('Lost'));
        await test.owner.find();
        test.login(undefined);
        expect(test.owner.getState()).toEqual({ snapshot: null, busy: false, retryPending: false, error: null });
    });

    it('rejects another scope or account and prevents stale entry after a failed fresh read', async () => {
        const test = browser();
        test.state(matched);
        await test.owner.start();
        test.api.read.mockResolvedValueOnce({
            scope: { ...scope, applicationId: 'other' },
            principalId: 'alice',
            observedAtEpochMs: 1,
            state: { status: 'idle' }
        });
        await test.owner.refresh();
        expect(test.owner.getState().snapshot).toBeNull();
        expect(test.owner.getState().error).toContain('scope');
        await test.owner.refresh();
        test.api.read.mockRejectedValueOnce(new Error('Offline'));
        await test.owner.enter();
        expect(test.enter).not.toHaveBeenCalled();
        expect(test.owner.getState().error).toBe('Offline');
    });

    it('pauses background polling, refreshes on return and stops without cancelling the durable search', async () => {
        vi.useFakeTimers();
        const test = browser();
        test.state({ status: 'searching', searchId: 'alice-search', expiresAtEpochMs: 120000 });
        await test.owner.start();
        test.active(false);
        await vi.advanceTimersByTimeAsync(3000);
        expect(test.api.read).toHaveBeenCalledTimes(1);
        test.active(true);
        await test.owner.refresh();
        expect(test.api.read).toHaveBeenCalledTimes(2);
        test.owner.stop();
        await vi.advanceTimersByTimeAsync(3000);
        expect(test.api.read).toHaveBeenCalledTimes(2);
        expect(test.api.change).not.toHaveBeenCalled();
    });
});
