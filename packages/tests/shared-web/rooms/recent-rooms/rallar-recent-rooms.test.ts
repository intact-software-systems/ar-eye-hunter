// @vitest-environment happy-dom
import '../../../setup-browser-indexeddb.ts';

import { createRallarDataFacade, type RallarDataStore } from '@shared-web/browser/rallar-data.ts';
import type { RallarStateListener } from '@shared-web/browser/rallar-shared-contracts.ts';
import { RallarRoomEntry } from '@shared-web/browser/rooms/entry/rallar-room-entry.ts';
import type { RallarRoomState } from '@shared-web/browser/rooms/rallar-room-contracts.ts';
import { RallarRecentRooms } from '@shared-web/browser/rooms/recent-rooms/rallar-recent-rooms.ts';
import type { RallarAuthChangeListener } from '@shared-web/browser/session/rallar-auth-facade.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { ApiJsonObject } from '@shared/api/api-json-value.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGroupSnapshotFixture } from '../../authoritative-group-fixtures.ts';
import { installFakeBroadcastChannelPerTest } from '../../data/rallar-data-test-runtime.ts';

const SCOPE = { applicationId: 'ar-eye-hunter', workspaceId: 'default' };
const ALICE: AuthSession = {
    clientId: 'alice',
    username: 'alice',
    sessionId: 'alice-session',
    accessToken: 'secret-token',
    expiresAtEpochMs: 100_000
};

class RecoveryBrowser {
    public session: AuthSession | undefined = ALICE;
    public now = 100;
    public failOpen = false;
    public nextOpen: Promise<void> | null = null;
    public onOpen: <V>(store: RallarDataStore<V>) => void = () => {};
    public readonly manager = new RepositoryManager();
    public readonly data = createRallarDataFacade({ manager: this.manager, resolveScopeKey: (scope) => scope });
    public readonly dbName = `recent-rooms-${crypto.randomUUID()}`;
    public readonly authListeners = new Set<RallarAuthChangeListener>();
    public readonly roomListeners = new Set<RallarStateListener<RallarRoomState>>();
    public readonly storage = new Map<string, string>();
    public readonly histories: RallarRecentRooms[] = [];
    public readonly auth: RallarRoomEntry.Auth = {
        session: () => this.session,
        onChange: (listener) => {
            this.authListeners.add(listener);
            return () => {
                this.authListeners.delete(listener);
            };
        }
    };
    public readonly entry = new RallarRoomEntry({
        auth: this.auth,
        rooms: {
            join: async (roomRef) => createGroupSnapshotFixture({ ...roomRef, sessionIds: [this.session?.sessionId ?? ''] }),
            onChange: (listener) => {
                this.roomListeners.add(listener);
                return () => {
                    this.roomListeners.delete(listener);
                };
            }
        },
        storage: {
            getItem: (key) => this.storage.get(key) ?? null,
            setItem: (key, value) => {
                this.storage.set(key, value);
            },
            removeItem: (key) => {
                this.storage.delete(key);
            }
        },
        location: { read: () => 'https://game.example/', replace: () => {}, onChange: () => () => {} }
    }, { scope: SCOPE });

    public constructor() {
        this.entry.start();
    }

    public createHistory(scope: StateScope = SCOPE): RallarRecentRooms {
        const history = new RallarRecentRooms({
            auth: this.auth,
            entry: this.entry,
            now: () => this.now,
            data: {
                open: async (input, options) => {
                    if (this.failOpen) {
                        throw new Error('IndexedDB unavailable');
                    }
                    const barrier = this.nextOpen;
                    this.nextOpen = null;
                    const store = await this.data.open(input, { ...options, dbName: this.dbName });
                    this.onOpen(store);
                    await barrier;
                    return store;
                }
            }
        }, { scope });
        this.histories.push(history);
        return history;
    }

    public authenticate(principalId: string | null): void {
        this.session = principalId === null ? undefined : { ...ALICE, clientId: principalId, sessionId: `${principalId}-session` };
        for (const listener of this.authListeners) {
            void listener({ authenticated: !!this.session, session: this.session, reason: this.session ? 'login' : 'logout' });
        }
    }

    public async visit(groupId: string): Promise<void> {
        this.now += 1;
        this.entry.enter({ roomRef: { ...SCOPE, groupId }, joinCode: 'secret-code' });
        await this.entry.resume();
        await Promise.all(this.histories.map((history) => history.whenIdle()));
    }

    public async close(): Promise<void> {
        this.entry.stop();
        await Promise.all(this.histories.map((history) => history.stop()));
        await this.manager.clear();
    }
}

installFakeBroadcastChannelPerTest();
const browsers: RecoveryBrowser[] = [];
function createBrowser(): RecoveryBrowser {
    const browser = new RecoveryBrowser();
    browsers.push(browser);
    return browser;
}
afterEach(async () => {
    await Promise.all(browsers.splice(0).map((browser) => browser.close()));
});

describe('recent room navigation history', () => {
    it('records a created room using only its scoped reference from the full group snapshot', async () => {
        const browser = createBrowser();
        const history = browser.createHistory();
        await history.start();
        const roomRef = { ...SCOPE, groupId: 'created-room' };
        const currentRoom = createGroupSnapshotFixture({ ...roomRef, sessionIds: ['alice-session'] });
        for (const listener of browser.roomListeners) {
            void listener({ rooms: [], members: [], currentRoom, currentRoomId: roomRef.groupId, currentRoomRef: currentRoom.group });
        }
        await history.whenIdle();

        expect(history.getState()).toEqual({
            principalId: 'alice',
            status: 'ready',
            failure: null,
            rooms: [{ roomRef, visitedAtEpochMs: browser.now }]
        });
        expect(browser.entry.getState().destination).toEqual({ roomRef, joinCode: null });
    });

    it('persists ten distinct visits newest first and rehydrates without credentials', async () => {
        const browser = createBrowser();
        const history = browser.createHistory();
        await history.start();
        for (let room = 0; room < 12; room += 1) {
            await browser.visit(`room-${room}`);
        }
        await browser.visit('room-5');
        expect(history.getState().rooms.map((visit) => visit.roomRef.groupId))
            .toEqual(['room-5', 'room-11', 'room-10', 'room-9', 'room-8', 'room-7', 'room-6', 'room-4', 'room-3', 'room-2']);
        const state = history.getState();
        await history.stop();
        browser.entry.cancel();
        const reloaded = browser.createHistory();
        await reloaded.start();

        expect(reloaded.getState()).toEqual(state);
        const raw = await browser.data.open<ApiJsonObject>('recent-rooms:["ar-eye-hunter","default"]', {
            dbName: browser.dbName,
            scope: 'principal:alice'
        });
        expect(await raw.get('history')).toEqual({ rooms: state.rooms });
        expect(JSON.stringify(await raw.exportData())).not.toMatch(/secret-code|secret-token|joinCode|accessToken/);
    });

    it('forgets a current room durably without changing admission or recording it again on repeated start', async () => {
        const browser = createBrowser();
        const history = browser.createHistory();
        await history.start();
        await browser.visit('room-a');
        await history.forget({ ...SCOPE, groupId: 'room-a' }, 'alice');
        await history.start();

        expect(history.getState().rooms).toEqual([]);
        expect(browser.entry.getState().status).toBe('entered');
        await history.stop();
        browser.entry.cancel();
        await browser.createHistory().start();
        expect(browser.histories[1].getState().rooms).toEqual([]);
    });

    it('hides history immediately on logout and isolates accounts and application/workspace scopes', async () => {
        const browser = createBrowser();
        const history = browser.createHistory();
        await history.start();
        await browser.visit('alice-room');
        browser.authenticate(null);
        expect(history.getState()).toMatchObject({ status: 'signed-out', principalId: null, rooms: [] });
        await history.whenIdle();
        browser.authenticate('bob');
        await history.whenIdle();
        expect(history.getState()).toMatchObject({ principalId: 'bob', rooms: [] });
        await browser.visit('bob-room');
        await history.forget({ ...SCOPE, groupId: 'bob-room' }, 'alice');
        expect(history.getState().rooms).toHaveLength(1);
        browser.authenticate('alice');
        await history.whenIdle();
        expect(history.getState().rooms.map((visit) => visit.roomRef.groupId)).toEqual(['alice-room']);
        for (const scope of [{ ...SCOPE, workspaceId: 'another' }, { ...SCOPE, applicationId: 'relic' }]) {
            const other = browser.createHistory(scope);
            await other.start();
            expect(other.getState().rooms).toEqual([]);
        }
    });

    it.each([null, 'bob'])('never delivers old history after an observer changes the account to %s', async (principalId) => {
        const browser = createBrowser();
        const history = browser.createHistory();
        await history.start();
        history.onChange((state) => {
            if (state.principalId === 'alice' && state.rooms.length > 0) {
                browser.authenticate(principalId);
            }
        });
        const observed: RallarRecentRooms.State[] = [];
        history.onChange((state) => {
            observed.push(state);
        });
        await browser.visit('alice-room');
        await history.whenIdle();

        const changed = observed.findIndex((state) => state.principalId === principalId);
        expect(changed).toBeGreaterThanOrEqual(0);
        expect(observed.slice(changed).every((state) => state.principalId === principalId && state.rooms.length === 0)).toBe(true);
        expect(observed.at(-1)).toBe(history.getState());
    });

    it('never navigates while hydrating history or displaces a newer invitation', async () => {
        const browser = createBrowser();
        const history = browser.createHistory();
        await history.start();
        await browser.visit('previous-room');
        await history.stop();
        const destination = { roomRef: { ...SCOPE, groupId: 'new-invitation' }, joinCode: 'new-code' };
        browser.entry.enter(destination);
        await history.start();

        expect(browser.entry.getState()).toMatchObject({ status: 'pending', destination });
        expect(history.getState().rooms.map((visit) => visit.roomRef.groupId)).toEqual(['previous-room']);
    });

    it('serializes a restart requested synchronously by a stopped-state observer', async () => {
        const browser = createBrowser();
        const history = browser.createHistory();
        await history.start();
        await browser.visit('room-a');
        let restart = true;
        const unsubscribe = history.onChange((state) => {
            if (restart && state.status === 'signed-out') {
                restart = false;
                void history.start();
            }
        });
        await history.stop();
        await history.whenIdle();
        await browser.visit('room-b');

        expect(history.getState().rooms.map((visit) => visit.roomRef.groupId)).toEqual(['room-b', 'room-a']);
        expect(browser.manager.size()).toBe(1);
        unsubscribe();
    });

    it('records ordinary room adoption during a reentrant loading notification', async () => {
        const browser = createBrowser();
        const history = browser.createHistory();
        history.onChange((state) => {
            if (state.status === 'loading') {
                const currentRoomRef = { ...SCOPE, groupId: 'created-room' };
                for (const listener of browser.roomListeners) {
                    void listener({
                        rooms: [],
                        members: [],
                        currentRoomRef,
                        currentRoomId: 'created-room',
                        currentRoom: createGroupSnapshotFixture({ ...currentRoomRef, sessionIds: ['alice'] })
                    });
                }
            }
        });
        await history.start();
        await history.whenIdle();

        expect(history.getState().rooms.map((visit) => visit.roomRef.groupId)).toEqual(['created-room']);
    });

    it.each(['replace-account', 'restart'] as const)('fences late store opening across %s', async (action) => {
        const browser = createBrowser();
        const barrier = Promise.withResolvers<void>();
        const opened = Promise.withResolvers<void>();
        browser.nextOpen = barrier.promise;
        browser.onOpen = () => {
            opened.resolve();
        };
        const history = browser.createHistory();
        const starting = history.start();
        await opened.promise;
        if (action === 'replace-account') {
            browser.authenticate('bob');
        }
        else {
            void history.stop();
            void history.start();
        }
        barrier.resolve();
        await starting;
        await history.whenIdle();
        await browser.visit('new-room');

        expect(history.getState()).toMatchObject({ status: 'ready', principalId: action === 'restart' ? 'alice' : 'bob' });
        expect(history.getState().rooms.map((visit) => visit.roomRef.groupId)).toEqual(['new-room']);
        expect(browser.manager.size()).toBe(1);
    });

    it('keeps a late write in its captured account while the next account starts empty', async () => {
        const browser = createBrowser();
        const barrier = Promise.withResolvers<void>();
        const writing = Promise.withResolvers<void>();
        browser.onOpen = (store) => {
            const set = store.set.bind(store);
            vi.spyOn(store, 'set').mockImplementationOnce(async (key, value) => {
                writing.resolve();
                await barrier.promise;
                await set(key, value);
            });
        };
        const history = browser.createHistory();
        await history.start();
        const visiting = browser.visit('alice-room');
        await writing.promise;
        browser.authenticate('bob');
        expect(history.getState().rooms).toEqual([]);
        barrier.resolve();
        await visiting;
        await history.whenIdle();
        expect(history.getState()).toMatchObject({ principalId: 'bob', status: 'ready', rooms: [] });
        browser.authenticate('alice');
        await history.whenIdle();
        expect(history.getState().rooms.map((visit) => visit.roomRef.groupId)).toEqual(['alice-room']);
    });

    it('reports unavailable storage independently of successful admission and supports retry', async () => {
        const browser = createBrowser();
        browser.failOpen = true;
        const history = browser.createHistory();
        await history.start();
        await browser.visit('room-a');
        expect(history.getState()).toMatchObject({ status: 'failed' });
        expect(browser.entry.getState().status).toBe('entered');
        browser.failOpen = false;
        await history.retry();
        await history.whenIdle();
        expect(history.getState()).toMatchObject({ status: 'ready', rooms: [{ roomRef: { ...SCOPE, groupId: 'room-a' } }] });
    });

    it('reports invalid persisted history without replacing it on retry', async () => {
        const browser = createBrowser();
        const invalid = { rooms: [{ roomRef: { ...SCOPE, groupId: 'bad' }, visitedAtEpochMs: 'yesterday' }] };
        const raw = await browser.data.open<ApiJsonObject>('recent-rooms:["ar-eye-hunter","default"]', {
            dbName: browser.dbName,
            scope: 'principal:alice'
        });
        await raw.set('history', invalid);
        const history = browser.createHistory();
        await history.start();
        expect(history.getState()).toMatchObject({ status: 'failed', rooms: [] });
        await browser.visit('room-a');
        await history.retry();
        expect(history.getState()).toMatchObject({ status: 'failed', rooms: [] });
        expect(await raw.get('history')).toEqual(invalid);
    });

    it('keeps admission successful when a history write fails and retries only local persistence', async () => {
        const browser = createBrowser();
        browser.onOpen = (store) => {
            vi.spyOn(store, 'set').mockRejectedValueOnce(new Error('Storage quota exceeded'));
            browser.onOpen = () => {};
        };
        const history = browser.createHistory();
        await history.start();
        await browser.visit('room-a');
        const entered = browser.entry.getState();
        expect(entered.status).toBe('entered');
        expect(history.getState()).toMatchObject({ status: 'failed' });

        await history.retry();
        await history.whenIdle();
        expect(browser.entry.getState()).toBe(entered);
        expect(history.getState()).toMatchObject({ status: 'ready', rooms: [{ roomRef: { ...SCOPE, groupId: 'room-a' } }] });
    });
});
