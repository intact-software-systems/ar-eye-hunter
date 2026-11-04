import type { RallarAuthState } from '@shared-web/browser/session/rallar-auth-facade.ts';
import { RallarTournamentCatalog } from '@shared-web/browser/tournaments/rallar-tournament-catalog.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { TournamentCatalogPage } from '@shared/api/tournaments/tournament-catalog.ts';
import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManualTimers } from '../../shared/resilience/manual-timers.ts';

const scope = { applicationId: 'game', workspaceId: 'default' };
const alice: AuthSession = { clientId: 'alice', username: 'alice', sessionId: 'alice-session', accessToken: 'test-only', expiresAtEpochMs: 9999999999999 };
const owners: RallarTournamentCatalog[] = [];
afterEach(() => owners.splice(0).forEach((owner) => owner.stop()));

function page(title: string, nextCursor: string | null = null): TournamentCatalogPage {
    return {
        scope,
        principalId: 'alice',
        view: 'public',
        observedAtEpochMs: 1000,
        nextCursor,
        entries: [{
            ref: { ...scope, tournamentId: title },
            title,
            organizerPrincipalId: 'host',
            status: 'registration',
            activeEntrantCount: 0,
            nextScheduledAtEpochMs: null
        }]
    };
}

function browser() {
    const timers = createManualTimers(0);
    const auth = new SynchronousNotifications<RallarAuthState>((error) => {
        throw error;
    });
    const activity = new SynchronousNotifications<void>((error) => {
        throw error;
    });
    const state: { session: AuthSession | undefined; active: boolean; } = { session: alice, active: true };
    const read = vi.fn<RallarTournamentCatalog.Api['read']>(async () => page('first', 'second'));
    const owner = new RallarTournamentCatalog({
        auth: { session: () => state.session, onChange: (listener) => auth.subscribe(listener).unsubscribe },
        activity: { isActive: () => state.active, onChange: (listener) => activity.subscribe(listener).unsubscribe },
        api: { read },
        timers
    }, { scope, limit: 20, refreshIntervalMs: 30000, timeoutMs: 10000 });
    owners.push(owner);
    return {
        owner,
        read,
        timers,
        authenticate(session: AuthSession | undefined) {
            state.session = session;
            auth.publishLatest({ authenticated: session !== undefined, session, reason: session ? 'login' : 'logout' });
        },
        active(active: boolean) {
            state.active = active;
            activity.publishLatest();
        }
    };
}

describe('tournament catalogue browser lifetime', () => {
    it('loads pages explicitly and preserves the prior page as stale when a later read fails', async () => {
        const test = browser();
        await test.owner.start();
        expect(test.owner.getState().entries.map((entry) => entry.title)).toEqual(['first']);
        test.read.mockRejectedValueOnce(new Error('offline'));
        await test.owner.loadMore();
        expect(test.owner.getState()).toMatchObject({ status: 'error', stale: true, nextCursor: 'second', error: 'offline' });
        expect(test.owner.getState().entries.map((entry) => entry.title)).toEqual(['first']);
        test.read.mockResolvedValueOnce(page('second'));
        await test.owner.loadMore();
        expect(test.owner.getState().entries.map((entry) => entry.title)).toEqual(['first', 'second']);
        expect(test.owner.getState().stale).toBe(true);
        test.read.mockResolvedValueOnce(page('fresh'));
        await test.owner.refresh();
        expect(test.owner.getState()).toMatchObject({ stale: false, nextCursor: null });
    });

    it('replaces the loaded range atomically and coalesces overlapping refreshes', async () => {
        const test = browser();
        await test.owner.start();
        test.read.mockResolvedValueOnce(page('second'));
        await test.owner.loadMore();
        const delayed = Promise.withResolvers<TournamentCatalogPage>();
        test.read.mockResolvedValueOnce(page('changed', 'second')).mockReturnValueOnce(delayed.promise);
        const first = test.owner.refresh();
        const second = test.owner.refresh();
        await vi.waitFor(() => expect(test.read).toHaveBeenCalledTimes(4));
        expect(test.owner.getState().entries.map((entry) => entry.title)).toEqual(['first', 'second']);
        delayed.resolve(page('last'));
        await Promise.all([first, second]);
        expect(test.owner.getState().entries.map((entry) => entry.title)).toEqual(['changed', 'last']);
    });

    it('refreshes the full range when an explicit refresh interrupts loading more', async () => {
        const test = browser();
        await test.owner.start();
        const delayed = Promise.withResolvers<TournamentCatalogPage>();
        test.read.mockReturnValueOnce(delayed.promise);
        const loading = test.owner.loadMore();
        test.read.mockResolvedValueOnce(page('current'));
        const refreshing = test.owner.refresh();
        delayed.resolve(page('old-next-page'));
        await Promise.all([loading, refreshing]);
        expect(test.owner.getState().entries.map((entry) => entry.title)).toEqual(['current']);
        expect(test.owner.getState()).toMatchObject({ stale: false, nextCursor: null });
    });

    it('keeps the entire previous range when a later refresh page fails or repeats its cursor', async () => {
        const test = browser();
        await test.owner.start();
        test.read.mockResolvedValueOnce(page('second'));
        await test.owner.loadMore();
        test.read.mockResolvedValueOnce(page('replacement', 'next')).mockRejectedValueOnce(new Error('page unavailable'));
        await test.owner.refresh();
        expect(test.owner.getState().entries.map((entry) => entry.title)).toEqual(['first', 'second']);
        expect(test.owner.getState()).toMatchObject({ stale: true, error: 'page unavailable' });
        test.read.mockResolvedValueOnce(page('replacement', 'next')).mockResolvedValueOnce(page('last', 'next'));
        await test.owner.refresh();
        expect(test.owner.getState().entries.map((entry) => entry.title)).toEqual(['first', 'second']);
        expect(test.owner.getState().error).toContain('repeated its continuation');
    });

    it('aborts reads on stop and ignores a late completion', async () => {
        const test = browser();
        const delayed = Promise.withResolvers<TournamentCatalogPage>();
        test.read.mockReturnValueOnce(delayed.promise);
        const starting = test.owner.start();
        const signal = test.read.mock.calls[0][0].signal;
        test.owner.stop();
        expect(signal.aborted).toBe(true);
        delayed.resolve(page('late'));
        await starting;
        expect(test.owner.getState().entries).toEqual([]);
        await test.timers.advance(60000);
        expect(test.read).toHaveBeenCalledTimes(1);
    });

    it('clears personal data on account replacement and ignores the old account response', async () => {
        const test = browser();
        const old = Promise.withResolvers<TournamentCatalogPage>();
        test.read.mockReturnValueOnce(old.promise);
        const starting = test.owner.start();
        test.read.mockResolvedValueOnce({ ...page('bob-cup'), principalId: 'bob' });
        test.authenticate({ ...alice, clientId: 'bob', sessionId: 'bob-session' });
        await test.owner.refresh();
        old.resolve(page('private-alice-cup'));
        await starting;
        expect(test.owner.getState().entries.map((entry) => entry.title)).toEqual(['bob-cup']);
        test.authenticate(undefined);
        expect(test.owner.getState()).toMatchObject({ status: 'signed-out', entries: [], nextCursor: null });
    });

    it('fences view changes and rejects a response for another scope', async () => {
        const test = browser();
        const old = Promise.withResolvers<TournamentCatalogPage>();
        test.read.mockReturnValueOnce(old.promise);
        const starting = test.owner.start();
        test.read.mockResolvedValueOnce({ ...page('mine'), view: 'mine' });
        await test.owner.changeView('mine');
        old.resolve(page('public'));
        await starting;
        expect(test.owner.getState().entries.map((entry) => entry.title)).toEqual(['mine']);
        test.read.mockResolvedValueOnce({ ...page('wrong'), view: 'mine', scope: { ...scope, workspaceId: 'other' } });
        await test.owner.refresh();
        expect(test.owner.getState()).toMatchObject({ status: 'error', stale: true });
        expect(test.owner.getState().entries.map((entry) => entry.title)).toEqual(['mine']);
    });

    it('pauses while hidden or offline and refreshes immediately on return with cadence after completion', async () => {
        const test = browser();
        await test.owner.start();
        test.active(false);
        await test.timers.advance(60000);
        expect(test.owner.getState()).toMatchObject({ paused: true, stale: true });
        expect(test.read).toHaveBeenCalledTimes(1);
        test.read.mockResolvedValueOnce(page('returned'));
        test.active(true);
        await test.owner.refresh();
        expect(test.owner.getState().entries.map((entry) => entry.title)).toEqual(['returned']);
        await test.timers.advance(29999);
        expect(test.read).toHaveBeenCalledTimes(2);
        test.read.mockResolvedValueOnce(page('automatic'));
        await test.timers.advance(1);
        expect(test.owner.getState().entries.map((entry) => entry.title)).toEqual(['automatic']);
    });
});
