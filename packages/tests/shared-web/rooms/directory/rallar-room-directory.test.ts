import { describe, expect, it } from 'vitest';

import type { RallarScopedOperationOptions } from '@shared-web/browser/rallar-connection-facade.ts';
import { RallarRoomDirectory } from '@shared-web/browser/rooms/directory/rallar-room-directory.ts';
import type { RallarAuthChangeListener } from '@shared-web/browser/session/rallar-auth-facade.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupDirectoryEntry, GroupDirectoryPage, GroupDirectoryRequest } from '@shared/api/group-directory/group-directory-types.ts';
import { createManualTimers } from '../../../shared/resilience/manual-timers.ts';

const SCOPE = { applicationId: 'game', workspaceId: 'lobby' };
const QUERY = { kind: 'room', q: 'arena', limit: 50, includeEmpty: false, order: 'online-members' } as const;
const ALICE: AuthSession = {
    clientId: 'alice',
    username: 'alice',
    sessionId: 'alice-session',
    accessToken: 'test-only',
    expiresAtEpochMs: 1_000_000
};

class DirectoryBrowser {
    readonly timers = createManualTimers(0);
    readonly authListeners = new Set<RallarAuthChangeListener>();
    readonly activityListeners = new Set<() => void>();
    readonly requests: { request: GroupDirectoryRequest; options: RallarScopedOperationOptions | undefined; }[] = [];
    session: AuthSession | undefined = ALICE;
    active = true;
    readPage: (request: GroupDirectoryRequest) => Promise<GroupDirectoryPage> = async () => ({ entries: [], nextCursor: null });
    readonly directory = new RallarRoomDirectory({
        auth: {
            session: () => this.session,
            onChange: (listener) => {
                this.authListeners.add(listener);
                return () => {
                    this.authListeners.delete(listener);
                };
            }
        },
        rooms: {
            directory: async (request = {}, options) => {
                this.requests.push({ request, options });
                return this.readPage(request);
            }
        },
        timers: this.timers,
        activity: {
            isActive: () => this.active,
            onChange: (listener) => {
                this.activityListeners.add(listener);
                return () => {
                    this.activityListeners.delete(listener);
                };
            }
        }
    }, { scope: SCOPE, request: QUERY, refreshIntervalMs: 30_000, timeoutMs: 10_000, maxAttempts: 1 });

    authenticate(session: AuthSession | undefined): void {
        this.session = session;
        for (const listener of this.authListeners) {
            void listener({ authenticated: !!session, session, reason: session ? 'login' : 'logout' });
        }
    }

    setActive(active: boolean): void {
        this.active = active;
        for (const listener of this.activityListeners) {
            listener();
        }
    }
}

function room(groupId: string): GroupDirectoryEntry {
    return {
        groupRef: { ...SCOPE, groupId },
        displayName: groupId,
        kind: 'room',
        joinMode: 'open',
        memberCount: 1,
        onlineMemberCount: 1,
        maxMembers: 8,
        isFull: false,
        lifecycleState: 'active',
        peerRttMs: null
    };
}

describe('room directory freshness', () => {
    it('publishes initial entries and replaces them automatically after thirty seconds', async () => {
        const browser = new DirectoryBrowser();
        browser.readPage = async () => ({ entries: [room('first')], nextCursor: null });
        await browser.directory.start();
        expect(browser.directory.getState()).toEqual({ status: 'ready', entries: [room('first')], error: undefined });
        expect(browser.requests[0]?.options).toMatchObject({ scope: SCOPE, timeoutMs: 10_000, maxAttempts: 1 });
        browser.readPage = async () => ({ entries: [room('new')], nextCursor: null });
        await browser.timers.advance(29_999);
        expect(browser.directory.getState().entries).toEqual([room('first')]);
        await browser.timers.advance(1);
        expect(browser.directory.getState().entries).toEqual([room('new')]);
        browser.directory.stop();
        await browser.timers.advance(60_000);
        expect(browser.requests).toHaveLength(2);
        expect(browser.authListeners.size + browser.activityListeners.size).toBe(0);
    });

    it('waits a full interval after manual completion before polling again', async () => {
        const browser = new DirectoryBrowser();
        await browser.directory.start();
        await browser.timers.advance(25_000);
        await browser.directory.refresh();
        await browser.timers.advance(29_999);
        expect(browser.requests).toHaveLength(2);
        await browser.timers.advance(1);
        expect(browser.requests).toHaveLength(3);
        browser.directory.stop();
    });

    it('deduplicates all pages and retains the complete result when a later page fails', async () => {
        const browser = new DirectoryBrowser();
        browser.readPage = async (request) =>
            request.cursor
                ? { entries: [room('first'), room('second')], nextCursor: null }
                : { entries: [room('first')], nextCursor: 'next' };
        await browser.directory.start();
        expect(browser.directory.getState().entries).toEqual([room('first'), room('second')]);
        browser.readPage = async (request) => {
            if (request.cursor) {
                throw new Error('page unavailable');
            }
            return { entries: [room('partial')], nextCursor: 'next' };
        };
        await browser.timers.advance(30_000);
        expect(browser.directory.getState()).toEqual({ status: 'error', entries: [room('first'), room('second')], error: 'page unavailable' });
        browser.readPage = async () => ({ entries: [], nextCursor: null });
        await browser.timers.advance(30_000);
        expect(browser.directory.getState()).toEqual({ status: 'ready', entries: [], error: undefined });
        browser.directory.stop();
    });

    it('rejects a repeated cursor without publishing partial results', async () => {
        const browser = new DirectoryBrowser();
        browser.readPage = async () => ({ entries: [room('partial')], nextCursor: 'same' });
        await browser.directory.start();
        expect(browser.directory.getState().status).toBe('error');
        expect(browser.directory.getState().entries).toEqual([]);
        expect(browser.requests).toHaveLength(2);
        browser.directory.stop();
    });

    it('pauses automatic work when inactive and immediately refreshes on return', async () => {
        const browser = new DirectoryBrowser();
        browser.active = false;
        await browser.directory.start();
        await browser.timers.advance(60_000);
        expect(browser.requests).toEqual([]);
        browser.setActive(true);
        await browser.directory.refresh();
        expect(browser.requests).toHaveLength(1);
        browser.setActive(false);
        await browser.timers.advance(60_000);
        expect(browser.requests).toHaveLength(1);
        await browser.directory.refresh();
        expect(browser.requests).toHaveLength(2);
        browser.directory.stop();
    });

    it('coalesces manual refreshes and fences an old query and its remaining pages', async () => {
        const browser = new DirectoryBrowser();
        const older = Promise.withResolvers<GroupDirectoryPage>();
        browser.readPage = async () => older.promise;
        const starting = browser.directory.start();
        const manual = browser.directory.refresh();
        await Promise.resolve();
        expect(browser.requests).toHaveLength(1);
        browser.readPage = async () => ({ entries: [room('measured')], nextCursor: null });
        await browser.directory.changeRequest({ ...QUERY, order: 'peer-rtt' });
        older.resolve({ entries: [room('obsolete')], nextCursor: 'old-next' });
        await Promise.all([starting, manual]);
        expect(browser.directory.getState().entries).toEqual([room('measured')]);
        expect(browser.requests.map(({ request }) => request.order)).toEqual(['online-members', 'peer-rtt']);
        expect(browser.requests[0]?.options?.signal?.aborted).toBe(true);
        browser.directory.stop();
    });

    it('clears logout results and rejects late data after another account signs in', async () => {
        const browser = new DirectoryBrowser();
        const older = Promise.withResolvers<GroupDirectoryPage>();
        browser.readPage = async () => older.promise;
        const starting = browser.directory.start();
        await Promise.resolve();
        browser.authenticate(undefined);
        expect(browser.directory.getState()).toEqual({ status: 'idle', entries: [], error: undefined });
        browser.readPage = async () => ({ entries: [room('bob-room')], nextCursor: null });
        browser.authenticate({ ...ALICE, clientId: 'bob', sessionId: 'bob-session' });
        await browser.directory.refresh();
        older.resolve({ entries: [room('alice-room')], nextCursor: null });
        await starting;
        expect(browser.directory.getState().entries).toEqual([room('bob-room')]);
        browser.directory.stop();
    });

    it('keeps a restarted loop alive when an earlier stopped request finishes', async () => {
        const browser = new DirectoryBrowser();
        const older = Promise.withResolvers<GroupDirectoryPage>();
        browser.readPage = async () => older.promise;
        const first = browser.directory.start();
        await Promise.resolve();
        browser.directory.stop();
        browser.readPage = async () => ({ entries: [room('restarted')], nextCursor: null });
        await browser.directory.start();
        older.resolve({ entries: [room('stopped')], nextCursor: null });
        await first;
        expect(browser.directory.getState().entries).toEqual([room('restarted')]);
        await browser.timers.advance(30_000);
        expect(browser.requests).toHaveLength(3);
        browser.directory.stop();
    });

    it('permits reentrant refresh and stop notifications without duplicate work or leaked timers', async () => {
        const browser = new DirectoryBrowser();
        browser.directory.onChange((state) => {
            if (state.status === 'loading') {
                void browser.directory.refresh();
            }
            if (state.status === 'ready') {
                browser.directory.stop();
            }
        });
        await browser.directory.start();
        expect(browser.requests).toHaveLength(1);
        expect(browser.timers.pendingCount()).toBe(0);
        await browser.timers.advance(60_000);
        expect(browser.requests).toHaveLength(1);
    });
});
