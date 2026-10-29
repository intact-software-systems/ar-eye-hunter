import {
    describe,
    expect,
    it
} from 'vitest';

import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import type { RallarStateListener } from '@shared-web/browser/rallar-shared-contracts.ts';
import {
    RallarRoomEntry,
    readRoomEntryDestination,
    toRoomEntryUrl
} from '@shared-web/browser/rooms/entry/rallar-room-entry.ts';
import type { RallarJoinRoomOptions, RallarRoomState } from '@shared-web/browser/rooms/rallar-room-contracts.ts';
import type { RallarAuthChangeListener } from '@shared-web/browser/session/rallar-auth-facade.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

import { createGroupSnapshotFixture } from '../../authoritative-group-fixtures.ts';

const SCOPE = { applicationId: 'ar-eye-hunter', workspaceId: 'default' };
const DESTINATION: RallarRoomEntry.Destination = {
    roomRef: { ...SCOPE, groupId: 'private-room' },
    joinCode: 'CODE +/&?',
    participation: 'preserve'
};
const FRAGMENT = '#rallar-room?applicationId=ar-eye-hunter&workspaceId=default&groupId=private-room';

describe('private-room share links', () => {
    it('round-trips the exact scoped destination and keeps the code out of the request URL', () => {
        const encoded = toRoomEntryUrl('https://game.example/play?unrelated=value#old', DESTINATION);
        expect(encoded.left).toBeUndefined();
        const link = new URL(encoded.right ?? 'https://unexpected.example');

        expect(link.origin + link.pathname + link.search).toBe('https://game.example/play');
        expect(link.hash).toContain('joinCode=');
        expect(readRoomEntryDestination(link.href, SCOPE).right).toEqual(DESTINATION);
    });

    it('shares an invite-only reference without implying authorization or a code', () => {
        const destination = { ...DESTINATION, joinCode: null };
        const link = toRoomEntryUrl('https://game.example/', destination).right ?? '';

        expect(link).not.toContain('joinCode');
        expect(readRoomEntryDestination(link, SCOPE).right).toEqual(destination);
    });

    it.each([
        FRAGMENT + '&groupId=another-room',
        FRAGMENT + '&apiHost=https%3A%2F%2Fevil.example',
        FRAGMENT + '&joinCode=',
        FRAGMENT + '&joinCode=%ZZ',
        FRAGMENT.replace('workspaceId=default&', ''),
        FRAGMENT.replace('groupId=private-room', 'groupId=..%2Fother'),
        FRAGMENT.replace('ar-eye-hunter', 'relic'),
        FRAGMENT.replace('workspaceId=default', 'workspaceId=elsewhere'),
        '#rallar-room',
        '#rallar-room-v2?groupId=private-room'
    ])('rejects malformed, ambiguous, unsupported, or wrong-scope destinations: %s', (fragment) => {
        expect(readRoomEntryDestination(`https://game.example/${fragment}`, SCOPE).left)
            .toMatchObject({ kind: 'invalid-destination' });
    });

    it.each(['https://game.example/', 'https://game.example/#settings'])('treats an unrelated URL as no room intent', (url) => {
        expect(readRoomEntryDestination(url, SCOPE).right).toBeNull();
    });

    it.each(['https://user:password@game.example/', 'javascript:alert(1)', 'not a URL'])(
        'does not build a share link from a credential-bearing or unsupported base: %s',
        (url) => expect(toRoomEntryUrl(url, DESTINATION).left).toMatchObject({ kind: 'invalid-destination' })
    );
});

const SESSION: AuthSession = {
    clientId: 'alice',
    username: 'alice',
    sessionId: 'alice-session',
    accessToken: 'private-auth-token',
    expiresAtEpochMs: 100_000
};

interface EntryRequest {
    readonly roomRef: GroupRef;
    readonly options: RallarJoinRoomOptions;
}

class EntryBrowser {
    public url = 'https://game.example/';
    public session: AuthSession | undefined;
    public readonly storage = new Map<string, string>();
    public readonly requests: EntryRequest[] = [];
    public readonly authListeners = new Set<RallarAuthChangeListener>();
    public readonly roomListeners = new Set<RallarStateListener<RallarRoomState>>();
    public readonly locationListeners = new Set<() => void>();
    public failStorageWrite = false;
    public failStorageRead = false;
    public respond: (roomRef: GroupRef) => Promise<GroupSnapshot> = async (roomRef) => roomSnapshot(roomRef);

    public createEntry(): RallarRoomEntry {
        return new RallarRoomEntry({
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
                join: (roomRef, options) => {
                    this.requests.push({ roomRef, options });
                    return this.respond(roomRef);
                },
                onChange: (listener) => {
                    this.roomListeners.add(listener);
                    return () => {
                        this.roomListeners.delete(listener);
                    };
                }
            },
            storage: {
                getItem: (key) => {
                    if (this.failStorageRead) {
                        throw new Error('Storage unavailable');
                    }
                    return this.storage.get(key) ?? null;
                },
                setItem: (key, value) => {
                    if (this.failStorageWrite) {
                        throw new Error('Storage unavailable');
                    }
                    this.storage.set(key, value);
                },
                removeItem: (key) => {
                    this.storage.delete(key);
                }
            },
            location: {
                read: () => this.url,
                replace: (url) => {
                    this.url = url;
                },
                onChange: (listener) => {
                    this.locationListeners.add(listener);
                    return () => {
                        this.locationListeners.delete(listener);
                    };
                }
            }
        }, { scope: SCOPE });
    }

    public authenticate(session: AuthSession | undefined = SESSION): void {
        this.session = session;
        for (const listener of this.authListeners) {
            void listener({ authenticated: session !== undefined, reason: session ? 'login' : 'logout', session });
        }
    }

    public currentRoom(roomRef: GroupRef | null): void {
        const currentRoom = roomRef ? roomSnapshot(roomRef) : undefined;
        for (const listener of this.roomListeners) {
            void listener({ rooms: [], members: [], currentRoom, currentRoomId: roomRef?.groupId, currentRoomRef: roomRef ?? undefined });
        }
    }

    public navigate(url: string): void {
        this.url = url;
        for (const listener of this.locationListeners) {
            listener();
        }
    }
}

describe('pending room entry lifecycle', () => {
    it('keeps watch intent across sign-in and reload, then resumes without implicit promotion', async () => {
        const browser = new EntryBrowser();
        const entry = browser.createEntry();
        entry.start();
        entry.enter({ ...DESTINATION, participation: 'spectator' });
        expect((await entry.resume()).status).toBe('pending');
        browser.authenticate();
        expect((await entry.resume()).status).toBe('entered');
        expect(browser.requests[0].options.participation).toBe('spectator');
        entry.stop();

        const reloaded = browser.createEntry();
        reloaded.start();
        expect((await reloaded.resume()).status).toBe('entered');
        expect(browser.requests[1].options.participation).toBeUndefined();
        expect(browser.requests[1].options.joinCode).toBeUndefined();
    });

    it('round-trips explicit watching and refuses an unknown participation intent', () => {
        const watching = { ...DESTINATION, participation: 'spectator' as const };
        const link = toRoomEntryUrl('https://game.example/', watching).right ?? '';
        expect(readRoomEntryDestination(link, SCOPE).right).toEqual(watching);
        expect(readRoomEntryDestination(link.replace('participation=spectator', 'participation=owner'), SCOPE).left)
            .toMatchObject({ kind: 'invalid-destination' });
    });

    it('returns with code-free admission bound to the selected account', async () => {
        const browser = new EntryBrowser();
        browser.authenticate();
        const entry = browser.createEntry();
        entry.start();

        expect(entry.returnTo(DESTINATION.roomRef, SESSION.clientId).right).toMatchObject({
            status: 'pending',
            principalId: 'alice',
            destination: { ...DESTINATION, joinCode: null }
        });
        expect(browser.requests).toEqual([]);
        expect((await entry.resume()).status).toBe('entered');
        expect(browser.requests[0]).toMatchObject({ roomRef: DESTINATION.roomRef });
        expect(browser.requests[0].options.joinCode).toBeUndefined();
        expect([...browser.storage.values()].join('')).not.toContain(DESTINATION.joinCode);
    });

    it('rejects a stale account or foreign scope without replacing a fresh invitation', () => {
        const browser = new EntryBrowser();
        browser.authenticate();
        const entry = browser.createEntry();
        entry.start();
        entry.enter(DESTINATION);

        expect(entry.returnTo(DESTINATION.roomRef, 'bob').left?.kind).toBe('account-mismatch');
        expect(entry.returnTo({ ...DESTINATION.roomRef, workspaceId: 'elsewhere' }, 'alice').left?.kind)
            .toBe('invalid-destination');
        expect(entry.getState()).toMatchObject({ status: 'pending', destination: DESTINATION, principalId: null });
        expect(browser.requests).toEqual([]);
    });

    it('cannot resume a recent-room selection under a replacement account', async () => {
        const browser = new EntryBrowser();
        browser.authenticate();
        const entry = browser.createEntry();
        entry.start();
        entry.returnTo(DESTINATION.roomRef, 'alice');
        browser.authenticate({ ...SESSION, clientId: 'bob', sessionId: 'bob-session' });

        expect(await entry.resume()).toMatchObject({ status: 'failed', failure: { kind: 'account-mismatch' } });
        expect(browser.requests).toEqual([]);
    });

    it.each([403, 404, 410])('keeps a denied return visible after server status %s', async (status) => {
        const browser = new EntryBrowser();
        browser.authenticate();
        browser.respond = async () => {
            throw new ApiHttpError('POST', '/join', status, 'unavailable');
        };
        const entry = browser.createEntry();
        entry.start();
        entry.returnTo(DESTINATION.roomRef, 'alice');

        expect(await entry.resume()).toMatchObject({
            status: 'failed',
            destination: { ...DESTINATION, joinCode: null },
            failure: { kind: 'denied' }
        });
        expect(browser.requests).toHaveLength(1);
    });

    it('survives sign-in and reload, then retains membership without the code or auth credentials', async () => {
        const browser = new EntryBrowser();
        browser.url = shareLink(DESTINATION);
        const initial = browser.createEntry();

        expect(initial.start()).toMatchObject({ status: 'pending', destination: DESTINATION });
        expect(new URL(browser.url).hash).toBe('');
        await initial.resume();
        expect(browser.requests).toEqual([]);
        initial.stop();
        const signedIn = browser.createEntry();
        signedIn.start();
        browser.authenticate();

        expect(await signedIn.resume()).toMatchObject({ status: 'entered', destination: { ...DESTINATION, joinCode: null } });
        expect(browser.requests[0]).toMatchObject({ roomRef: DESTINATION.roomRef, options: { joinCode: DESTINATION.joinCode } });
        expect([...browser.storage.values()].join('')).not.toContain(DESTINATION.joinCode);
        expect([...browser.storage.values()].join('')).not.toContain(SESSION.accessToken);
        signedIn.stop();
        const reloaded = browser.createEntry();
        reloaded.start();
        await reloaded.resume();

        expect(browser.requests[1].roomRef).toEqual(DESTINATION.roomRef);
        expect(browser.requests[1].options.joinCode).toBeUndefined();
        expect(reloaded.getState().status).toBe('entered');
    });

    it('gives a fresh link precedence over saved membership and retains a denied destination for retry', async () => {
        const browser = new EntryBrowser();
        browser.authenticate();
        const entry = browser.createEntry();
        entry.start();
        entry.enter({ roomRef: { ...SCOPE, groupId: 'old-room' }, joinCode: null, participation: 'preserve' });
        await entry.resume();
        entry.stop();
        browser.url = shareLink(DESTINATION);
        browser.respond = async () => {
            throw new ApiHttpError('POST', '/join', 403, 'denied');
        };
        const incoming = browser.createEntry();
        incoming.start();

        expect(await incoming.resume()).toMatchObject({ status: 'failed', destination: DESTINATION, failure: { kind: 'denied' } });
        expect(browser.requests.map((request) => request.roomRef.groupId)).toEqual(['old-room', 'private-room']);
        browser.respond = async (roomRef) => roomSnapshot(roomRef);
        expect((await incoming.resume()).status).toBe('entered');
    });

    it('requires the same account when resuming saved membership without a code', async () => {
        const browser = new EntryBrowser();
        browser.authenticate();
        const entry = browser.createEntry();
        entry.start();
        entry.enter(DESTINATION);
        await entry.resume();
        entry.stop();
        browser.authenticate({ ...SESSION, clientId: 'bob', sessionId: 'bob-session' });
        const reloaded = browser.createEntry();
        reloaded.start();

        expect(await reloaded.resume()).toMatchObject({ status: 'failed', failure: { kind: 'account-mismatch' } });
        expect(browser.requests).toHaveLength(1);
    });

    it('rejects a manual destination outside the configured scope before any effect', async () => {
        const browser = new EntryBrowser();
        browser.authenticate();
        const entry = browser.createEntry();
        entry.start();

        entry.enter({ ...DESTINATION, roomRef: { ...DESTINATION.roomRef, applicationId: 'other-app' } });
        await entry.resume();

        expect(entry.getState()).toMatchObject({ status: 'failed', failure: { kind: 'invalid-destination' } });
        expect(browser.requests).toEqual([]);
        expect(browser.storage.size).toBe(0);
    });

    it('preserves the link when storage fails and can retry once persistence works', async () => {
        const browser = new EntryBrowser();
        browser.authenticate();
        browser.url = shareLink(DESTINATION);
        browser.failStorageWrite = true;
        const entry = browser.createEntry();

        expect(entry.start()).toMatchObject({ status: 'failed', destination: DESTINATION, failure: { kind: 'storage' } });
        expect(readRoomEntryDestination(browser.url, SCOPE).right).toEqual(DESTINATION);
        await entry.resume();
        expect(browser.requests).toEqual([]);
        browser.failStorageWrite = false;

        expect((await entry.resume()).status).toBe('entered');
        expect(new URL(browser.url).hash).toBe('');
    });

    it('reports storage-read failure instead of presenting an empty lobby', () => {
        const browser = new EntryBrowser();
        browser.failStorageRead = true;

        expect(browser.createEntry().start()).toMatchObject({ status: 'failed', failure: { kind: 'storage' } });
    });

    it('coalesces resume calls and prevents an old result from overwriting a new destination', async () => {
        const browser = new EntryBrowser();
        browser.authenticate();
        const response = Promise.withResolvers<GroupSnapshot>();
        const started = Promise.withResolvers<void>();
        browser.respond = (roomRef) => {
            if (roomRef.groupId !== DESTINATION.roomRef.groupId) {
                return Promise.resolve(roomSnapshot(roomRef));
            }
            started.resolve();
            return response.promise;
        };
        const entry = browser.createEntry();
        entry.start();
        entry.enter(DESTINATION);
        const first = entry.resume();
        const repeated = entry.resume();
        await started.promise;
        expect(browser.requests).toHaveLength(1);
        const next = { roomRef: { ...SCOPE, groupId: 'next-room' }, joinCode: 'NEXT', participation: 'preserve' as const };

        entry.enter(next);
        await entry.resume();
        response.resolve(roomSnapshot(DESTINATION.roomRef));
        await Promise.all([first, repeated]);

        expect(browser.requests[0].options.signal?.aborted).toBe(true);
        expect(entry.getState()).toMatchObject({ status: 'entered', destination: { ...next, joinCode: null } });
        expect([...browser.storage.values()].join('')).toContain('next-room');
        expect([...browser.storage.values()].join('')).not.toContain('private-room');
    });

    it.each(['cancel', 'stop', 'replace-account'] as const)('fences late completion after %s', async (action) => {
        const browser = new EntryBrowser();
        browser.authenticate();
        const response = Promise.withResolvers<GroupSnapshot>();
        const started = Promise.withResolvers<void>();
        browser.respond = () => {
            started.resolve();
            return response.promise;
        };
        const entry = browser.createEntry();
        entry.start();
        entry.enter(DESTINATION);
        const pending = entry.resume();
        await started.promise;

        if (action === 'cancel') {
            entry.cancel();
        }
        else if (action === 'stop') {
            entry.stop();
        }
        else {
            browser.authenticate({ ...SESSION, clientId: 'bob', sessionId: 'bob-session' });
        }
        response.resolve(roomSnapshot(DESTINATION.roomRef));
        await pending;

        expect(browser.requests[0].options.signal?.aborted).toBe(true);
        expect(entry.getState().status).not.toBe('entered');
        if (action === 'cancel') {
            expect(entry.getState()).toMatchObject({ status: 'idle', destination: null });
            expect(browser.storage.size).toBe(0);
        }
    });

    it('keeps committed membership after partial entry and retries without retaining a stale code', async () => {
        const browser = new EntryBrowser();
        browser.authenticate();
        browser.respond = async () => {
            throw Object.assign(new Error('Presence unavailable', { cause: new Error('Network closed') }), {
                name: 'RallarRoomJoinPartialFailureError',
                joinedRoom: roomSnapshot(DESTINATION.roomRef)
            });
        };
        const entry = browser.createEntry();
        entry.start();
        entry.enter(DESTINATION);

        expect(await entry.resume()).toMatchObject({
            status: 'failed',
            destination: { ...DESTINATION, joinCode: null },
            failure: { kind: 'partial', admittedRoom: DESTINATION.roomRef }
        });
        expect([...browser.storage.values()].join('')).not.toContain(DESTINATION.joinCode);
        browser.respond = async (roomRef) => roomSnapshot(roomRef);
        await entry.resume();
        expect(browser.requests[1].options.joinCode).toBeUndefined();
    });

    it('remembers ordinary room changes and clears return state when the current room is left', async () => {
        const browser = new EntryBrowser();
        browser.authenticate();
        const entry = browser.createEntry();
        entry.start();
        browser.currentRoom(DESTINATION.roomRef);
        entry.stop();
        const restored = browser.createEntry();
        restored.start();

        await restored.resume();
        expect(browser.requests[0].roomRef).toEqual(DESTINATION.roomRef);
        browser.currentRoom(null);
        expect(restored.getState().status).toBe('idle');
        expect(browser.storage.size).toBe(0);
    });

    it('replaces an in-flight destination when a new link arrives in the same tab', async () => {
        const browser = new EntryBrowser();
        browser.authenticate();
        const response = Promise.withResolvers<GroupSnapshot>();
        const started = Promise.withResolvers<void>();
        browser.respond = (roomRef) => {
            started.resolve();
            return roomRef.groupId === 'private-room' ? response.promise : Promise.resolve(roomSnapshot(roomRef));
        };
        const entry = browser.createEntry();
        entry.start();
        entry.enter(DESTINATION);
        const pending = entry.resume();
        await started.promise;
        const next = { roomRef: { ...SCOPE, groupId: 'new-link' }, joinCode: 'NEW', participation: 'preserve' as const };

        browser.navigate(shareLink(next));
        expect(entry.getState()).toMatchObject({ status: 'pending', destination: next });
        expect(browser.requests[0].options.signal?.aborted).toBe(true);
        await entry.resume();
        response.resolve(roomSnapshot(DESTINATION.roomRef));
        await pending;

        expect(entry.getState()).toMatchObject({ status: 'entered', destination: { ...next, joinCode: null } });
        entry.stop();
        expect(browser.locationListeners.size).toBe(0);
    });

    it('does not restore a previous destination after a malformed new link', async () => {
        const browser = new EntryBrowser();
        browser.authenticate();
        const entry = browser.createEntry();
        entry.start();
        entry.enter(DESTINATION);
        await entry.resume();

        browser.navigate('https://game.example/#rallar-room?groupId=broken');
        await entry.resume();

        expect(entry.getState()).toMatchObject({ status: 'failed', destination: null, failure: { kind: 'invalid-destination' } });
        expect(browser.requests).toHaveLength(1);
    });

    it('ignores current rooms outside the configured application scope', () => {
        const browser = new EntryBrowser();
        browser.authenticate();
        const entry = browser.createEntry();
        entry.start();

        browser.currentRoom({ ...DESTINATION.roomRef, workspaceId: 'other-workspace' });

        expect(entry.getState().status).toBe('idle');
        expect(browser.storage.size).toBe(0);
    });

    it('can cancel from a joining notification before any transport effect', async () => {
        const browser = new EntryBrowser();
        browser.authenticate();
        const entry = browser.createEntry();
        entry.start();
        entry.enter(DESTINATION);
        entry.onChange((state) => {
            if (state.status === 'joining') {
                entry.cancel();
            }
        });
        const observed: RallarRoomEntry.State[] = [];
        entry.onChange((state) => {
            observed.push(state);
        });

        await entry.resume();

        expect(entry.getState().status).toBe('idle');
        expect(browser.requests).toEqual([]);
        expect(observed.map((state) => state.status)).toEqual(['pending', 'idle']);
        expect(observed.at(-1)).toBe(entry.getState());
    });

    it('publishes the pending state when stopped from a joining notification', async () => {
        const browser = new EntryBrowser();
        browser.authenticate();
        const entry = browser.createEntry();
        entry.start();
        entry.enter(DESTINATION);
        entry.onChange((state) => {
            if (state.status === 'joining') {
                entry.stop();
            }
        });
        const observed: RallarRoomEntry.State[] = [];
        entry.onChange((state) => {
            observed.push(state);
        });
        expect((await entry.resume()).status).toBe('pending');
        expect(browser.requests).toEqual([]);
        expect(observed.map((state) => state.status)).toEqual(['pending', 'pending']);
        expect(observed.at(-1)).toBe(entry.getState());
    });

    it('joins the same admission when a joining listener resumes synchronously', async () => {
        const browser = new EntryBrowser();
        browser.authenticate();
        const entry = browser.createEntry();
        entry.start();
        entry.enter(DESTINATION);
        const joined: Promise<RallarRoomEntry.State>[] = [];
        entry.onChange((state) => {
            if (state.status === 'joining') {
                joined.push(entry.resume());
            }
        });
        const result = entry.resume();
        expect((await result).status).toBe('entered');
        expect(joined[0]).toBe(result);
        expect(browser.requests).toHaveLength(1);
    });

    it('reports previous-room cleanup separately from reconnecting the admitted room', async () => {
        const browser = new EntryBrowser();
        browser.authenticate();
        browser.respond = async () => {
            throw Object.assign(new Error('Previous room leave failed'), {
                name: 'RallarRoomSwitchPartialFailureError',
                joinedRoom: roomSnapshot(DESTINATION.roomRef),
                previousRoomRef: { ...SCOPE, groupId: 'previous-room' }
            });
        };
        const entry = browser.createEntry();
        entry.start();
        entry.enter(DESTINATION);

        const failed = await entry.resume();

        expect(failed.failure).toMatchObject({ kind: 'partial', admittedRoom: DESTINATION.roomRef });
        expect(failed.failure?.message).toContain('leaving the previous room failed');
        expect(failed.failure?.message).toContain('Membership there may remain');
    });
});

function shareLink(destination: RallarRoomEntry.Destination): string {
    return toRoomEntryUrl('https://game.example/', destination).fold((failure) => {
        throw new Error(failure.message);
    }, (url) => url);
}

function roomSnapshot(roomRef: GroupRef): GroupSnapshot {
    return createGroupSnapshotFixture({ ...roomRef, sessionIds: ['alice'] });
}
