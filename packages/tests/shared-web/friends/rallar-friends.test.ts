import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import { RallarFriends } from '@shared-web/browser/friends/rallar-friends.ts';
import type { RallarAuthState } from '@shared-web/browser/session/rallar-auth-facade.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { FriendsView } from '@shared/api/friends/friends-view.ts';
import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

const alice: AuthSession = { clientId: 'alice', username: 'alice', sessionId: 'alice-session', accessToken: 'test', expiresAtEpochMs: 9_999_999_999_999 };
const scope = { applicationId: 'game', workspaceId: 'default' };
const invitation = {
    invitationId: 'invite-1',
    senderPrincipalId: 'bob',
    kind: 'room' as const,
    roomRef: { ...scope, groupId: 'room' },
    createdAtEpochMs: 1,
    expiresAtEpochMs: 9999999999999
};
const view: FriendsView = {
    principalId: 'alice',
    shareOnline: false,
    contacts: [{ principalId: 'bob', username: 'bob', displayName: 'Bob', status: 'friend', presence: 'hidden' }],
    invitations: [invitation]
};
const cleanups: (() => void)[] = [];
afterEach(() => {
    cleanups.splice(0).forEach((cleanup) => cleanup());
    vi.useRealTimers();
});

function browser() {
    let session: AuthSession | undefined = alice;
    let active = true;
    const authChanges = new SynchronousNotifications<RallarAuthState>((error) => {
        throw error;
    });
    const activityChanges = new SynchronousNotifications<void>((error) => {
        throw error;
    });
    const api = {
        read: vi.fn<RallarFriends.Api['read']>(async ({ session: caller }) => ({ ...view, principalId: caller.clientId })),
        change: vi.fn<RallarFriends.Api['change']>(async ({ session: caller, requestId }) => ({ principalId: caller.clientId, requestId, status: 'applied' }))
    };
    const enter = vi.fn();
    const owner = new RallarFriends({
        auth: { session: () => session, onChange: (listener) => authChanges.subscribe(listener).unsubscribe },
        activity: { isActive: () => active, onChange: (listener) => activityChanges.subscribe(listener).unsubscribe },
        api,
        entry: { enter },
        timers: createDefaultTimers(),
        createId: () => crypto.randomUUID()
    }, { scope, refreshIntervalMs: 30000 });
    cleanups.push(() => owner.stop());
    return {
        owner,
        api,
        enter,
        changeAuth(next: AuthSession | undefined) {
            session = next;
            authChanges.publishLatest({ authenticated: next !== undefined, reason: next ? 'login' : 'logout', session: next });
        },
        activity(next: boolean) {
            active = next;
            activityChanges.publishLatest();
        }
    };
}

describe('friends browser lifecycle', () => {
    it('loads the private view and preserves exact command identity after an ambiguous failure', async () => {
        const test = browser();
        await test.owner.start();
        expect(test.owner.getState().view).toEqual(view);
        test.api.change.mockRejectedValueOnce(new Error('Connection lost'));
        await test.owner.act({ action: 'visibility', shareOnline: true });
        expect(test.owner.getState()).toMatchObject({ retryPending: true, busy: false, error: 'Connection lost' });
        await test.owner.retry();
        expect(test.api.change.mock.calls[1]?.[0]).toEqual(test.api.change.mock.calls[0]?.[0]);
        expect(test.owner.getState()).toMatchObject({ retryPending: false, error: null });
    });

    it('releases a terminal exhausted request so a new action can proceed', async () => {
        const test = browser();
        await test.owner.start();
        test.api.change.mockRejectedValueOnce(
            new ApiHttpError(
                'POST',
                '/api/friends/requests/request',
                503,
                JSON.stringify({
                    type: 'api-mutation-failure',
                    version: 'canonical.v2',
                    code: 'app-inbox-retry-exhausted',
                    status: 503,
                    message: 'The request exhausted its retry budget.',
                    issues: null,
                    denial: null,
                    retry: { kind: 'exhausted', retryAfterMs: null, attempts: 20, lane: null, queueAgeMs: null, dueAgeMs: null }
                })
            )
        );
        await test.owner.act({ action: 'visibility', shareOnline: true });
        expect(test.owner.getState()).toMatchObject({
            retryPending: false,
            busy: false,
            error: 'The request could not complete. Review your friends and try the action again.'
        });
        await test.owner.act({ action: 'request', username: 'carol' });
        expect(test.api.change.mock.calls[1]?.[0].request).toEqual({ action: 'request', username: 'carol' });
        expect(test.api.change.mock.calls[1]?.[0].requestId).not.toBe(test.api.change.mock.calls[0]?.[0].requestId);
    });

    it('shows a readable refusal without leaving a retryable command', async () => {
        const test = browser();
        await test.owner.start();
        test.api.change.mockImplementationOnce(async ({ session, requestId }) => ({
            principalId: session.clientId,
            requestId,
            status: 'refused',
            code: 'destination-unavailable'
        }));
        await test.owner.act({ action: 'invite', principalId: 'bob', kind: 'room', roomRef: invitation.roomRef });
        expect(test.owner.getState()).toMatchObject({
            retryPending: false,
            error: 'This room or scheduled session is no longer available to invite people to.'
        });
    });

    it('discards late reads and pending writes on account replacement', async () => {
        const test = browser();
        const late = Promise.withResolvers<FriendsView>();
        test.api.read.mockReturnValueOnce(late.promise);
        const start = test.owner.start();
        test.changeAuth({ ...alice, clientId: 'carol', sessionId: 'carol-session' });
        await test.owner.refresh();
        late.resolve(view);
        await start;
        expect(test.owner.getState().view?.principalId).toBe('carol');
        test.changeAuth(undefined);
        expect(test.owner.getState()).toMatchObject({ view: null, retryPending: false });
    });

    it('rechecks an invitation before entering and refuses stale or foreign destinations', async () => {
        const test = browser();
        await test.owner.start();
        test.api.read.mockResolvedValueOnce({ ...view, invitations: [] });
        await test.owner.openInvitation(invitation.invitationId);
        expect(test.enter).not.toHaveBeenCalled();
        expect(test.owner.getState().error).toContain('no longer available');
        test.api.read.mockResolvedValueOnce({ ...view, invitations: [{ ...invitation, roomRef: { ...invitation.roomRef, applicationId: 'other' } }] });
        await test.owner.openInvitation(invitation.invitationId);
        expect(test.enter).not.toHaveBeenCalled();
        test.api.read.mockResolvedValue(view);
        await test.owner.openInvitation(invitation.invitationId);
        expect(test.enter).toHaveBeenCalledWith({ intent: 'join', roomRef: invitation.roomRef, joinCode: null, participation: 'player' });
    });

    it('polls only while foreground and online and clears private views after a failed read', async () => {
        vi.useFakeTimers();
        const test = browser();
        await test.owner.start();
        test.activity(false);
        await vi.advanceTimersByTimeAsync(60000);
        expect(test.api.read).toHaveBeenCalledTimes(1);
        test.activity(true);
        await test.owner.refresh();
        expect(test.api.read).toHaveBeenCalledTimes(2);
        test.api.read.mockRejectedValueOnce(new Error('Unavailable'));
        await test.owner.refresh();
        expect(test.owner.getState()).toMatchObject({ view: null, error: 'Unavailable' });
    });
});
