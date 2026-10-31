import { BrowserFacadeRuntimeState } from '@shared-web/browser/composition/browser-facade-runtime-state.ts';
import { BrowserTransportRuntime } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import { RoomStateStore } from '@shared-web/browser/rooms/room-state-store.ts';
import {
    createRallarStateCacheReadPort,
    RallarStateStore,
    type RallarStateCacheReadPort
} from '@shared-web/browser/state-cache/rallar-state-store.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { setClientStateSnapshots } from '@shared/repository/client-state-snapshots-repository.ts';
import {
    onGroupStateSnapshotChange,
    setGroupStateSnapshots,
    waitForGroupStateSnapshotChangesIdle
} from '@shared/repository/group-state-snapshots-repository.ts';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';
import { configureTestCacheRepositories } from '../../configure-test-cache-repositories.ts';
import { createDefaultTestSession } from '../api-middleware-test-double.ts';
import { createClientSnapshotFixture, createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';
import { createWebRtcGroupManager } from './browser-state-cache-lifecycle-fixtures.ts';

describe('Rallar state store', () => {
    beforeEach(() => {
        configureTestCacheRepositories();
    });

    it.each([false, true])('preserves explicit selection during attached-cache hydration with session superseded=%s', async (superseded) => {
        const context = {
            session: createDefaultTestSession(),
            middleware: { webRtcGroupManager: createWebRtcGroupManager() }
        };
        const { roomStateStore, stateStore } = createStateStoreFixture({}, () => context.session);
        const scope = { applicationId: 'app-1', workspaceId: 'workspace-1' };
        const previous = createGroupSnapshotFixture({ ...scope, groupId: 'previous', sessionIds: ['session-1'] });
        const selected = createGroupSnapshotFixture({ ...scope, groupId: 'selected', sessionIds: ['session-1'] });
        setGroupStateSnapshots([previous]);
        roomStateStore.setCurrentRoom(previous);
        await waitForGroupStateSnapshotChangesIdle();
        stateStore.attachCache();
        let current = true;
        const stop = onGroupStateSnapshotChange(() => {
            if (superseded) {
                current = false;
            }
        });
        const observed: (string | undefined)[] = [];
        roomStateStore.onChange((state) => {
            observed.push(state.currentRoomRef?.groupId);
        }, { emitCurrent: false });
        const adoption = stateStore.acceptSnapshots({
            context,
            clients: [],
            groups: [selected],
            scope,
            currentRoom: selected,
            assertCurrent: () => {
                if (!current) {
                    throw new Error('Entry session superseded');
                }
            }
        });
        try {
            if (superseded) {
                await expect(adoption).rejects.toThrow('Entry session superseded');
                expect(roomStateStore.resolveCurrentRoomRef()).toEqual(previous.group);
                expect(observed.length).toBeGreaterThan(0);
                expect(observed.every((groupId) => groupId === 'previous')).toBe(true);
            }
            else {
                await adoption;
                expect(roomStateStore.resolveCurrentRoomRef()).toEqual(selected.group);
                expect(observed.at(-1)).toBe('selected');
                expect(observed.slice(0, -1).every((groupId) => groupId === 'previous')).toBe(true);
            }
        }
        finally {
            stateStore.detachCache();
            stop();
        }
    });

    it('emits room, people, then derived state observers', () => {
        const events: string[] = [];
        const { roomStateStore, stateStore } = createStateStoreFixture();
        roomStateStore.onChange(() => {
            events.push('rooms');
        }, { emitCurrent: false });
        stateStore.onPeopleChange(() => {
            events.push('people');
        }, { emitCurrent: false });
        stateStore.onAfterEmit(() => events.push('derived'));

        stateStore.emit();

        expect(events).toEqual(['rooms', 'people', 'derived']);
    });

    it.each([
        {
            phase: 'rooms',
            expected: ['rooms:1', 'rooms:2', 'people:2', 'derived:2', 'late:2']
        },
        {
            phase: 'people',
            expected: ['rooms:1', 'people:1', 'rooms:2', 'people:2', 'derived:2', 'late:2']
        },
        {
            phase: 'derived',
            expected: ['rooms:1', 'people:1', 'derived:1', 'rooms:2', 'people:2', 'derived:2', 'late:2']
        }
    ])('stops superseded delivery after a nested $phase update', ({ phase, expected }) => {
        const events: string[] = [];
        const { roomStateStore, stateStore } = createStateStoreFixture();
        writeStateRevision(1);
        const publishNewerState = (from: string, revision: string | undefined): void => {
            events.push(`${from}:${revision}`);
            if (from === phase && revision === '1') {
                writeStateRevision(2);
                stateStore.emit();
            }
        };
        roomStateStore.onChange((state) => {
            publishNewerState('rooms', state.rooms[0]?.name);
        }, { emitCurrent: false });
        stateStore.onPeopleChange((state) => {
            publishNewerState('people', state.people[0]?.displayName);
        }, { emitCurrent: false });
        stateStore.onAfterEmit(() => {
            publishNewerState('derived', stateStore.peopleState().people[0]?.displayName);
        });
        stateStore.onAfterEmit(() => {
            events.push(`late:${stateStore.peopleState().people[0]?.displayName}`);
        });

        stateStore.emit();

        expect(events).toEqual(expected);
    });

    it.each(['rooms', 'people'] as const)('renews %s replay without duplicate delivery or stale teardown', (channel) => {
        const events: string[] = [];
        const { roomStateStore, stateStore } = createStateStoreFixture();
        const subscribe = channel === 'rooms'
            ? roomStateStore.onChange.bind(roomStateStore)
            : stateStore.onPeopleChange.bind(stateStore);
        const listener = (): void => {
            events.push('renewed');
        };
        let renew = true;
        subscribe(() => {
            if (renew) {
                renew = false;
                subscribe(listener);
                stale();
            }
        }, { emitCurrent: false });
        const stale = subscribe(listener, { emitCurrent: false });

        stateStore.emit();
        stateStore.emit();

        expect(events).toEqual(['renewed', 'renewed']);
    });

    it.each(['rooms', 'people'] as const)('defers %s subscriptions added without replay until the next publication', (channel) => {
        const events: string[] = [];
        const { roomStateStore, stateStore } = createStateStoreFixture();
        const subscribe = channel === 'rooms'
            ? roomStateStore.onChange.bind(roomStateStore)
            : stateStore.onPeopleChange.bind(stateStore);
        const listener = (): void => {
            events.push('new observer');
        };
        subscribe(() => {
            subscribe(listener, { emitCurrent: false });
        }, { emitCurrent: false });

        stateStore.emit();
        expect(events).toEqual([]);
        stateStore.emit();
        expect(events).toEqual(['new observer']);
    });

    it('isolates failing observers and reporting from every publication phase', () => {
        const { roomStateStore, stateStore } = createStateStoreFixture();
        const events: string[] = [];
        const reporting = vi.spyOn(console, 'error').mockImplementation(() => {
            throw new Error('reporting failed');
        });
        const fail = (): never => {
            throw new Error('observer failed');
        };
        try {
            roomStateStore.onChange(fail, { emitCurrent: false });
            roomStateStore.onChange(() => {
                events.push('rooms');
            }, { emitCurrent: false });
            stateStore.onPeopleChange(fail, { emitCurrent: false });
            stateStore.onPeopleChange(() => {
                events.push('people');
            }, { emitCurrent: false });
            stateStore.onAfterEmit(fail);
            stateStore.onAfterEmit(() => {
                events.push('derived');
            });

            expect(() => stateStore.emit()).not.toThrow();
            expect(events).toEqual(['rooms', 'people', 'derived']);
        }
        finally {
            reporting.mockRestore();
        }
    });

    it.each(['rooms', 'people'] as const)('does not retain a %s subscription when reading replay fails', (channel) => {
        let fault: Error | undefined = new Error('cache corrupted');
        const { roomStateStore, stateStore } = createStateStoreFixture({
            readGroupSnapshots: () => {
                if (fault) {
                    throw fault;
                }
                return [];
            },
            readClientSnapshots: () => {
                if (fault) {
                    throw fault;
                }
                return [];
            }
        });
        const subscribe = channel === 'rooms'
            ? roomStateStore.onChange.bind(roomStateStore)
            : stateStore.onPeopleChange.bind(stateStore);
        const events: string[] = [];
        expect(() =>
            subscribe(() => {
                events.push('leaked');
            })
        ).toThrow('cache corrupted');
        fault = undefined;
        stateStore.emit();
        expect(events).toEqual([]);
    });

    it('keeps subscriptions registered before caches become readable', () => {
        let configured = false;
        const stateCache = createRallarStateCacheReadPort();
        const { roomStateStore, stateStore } = createStateStoreFixture({
            readGroupSnapshots: () => {
                if (!configured) {
                    throw new Error('Repository not found: shared.repository.group-state-snapshots');
                }
                return stateCache.readGroupSnapshots();
            },
            readClientSnapshots: () => {
                if (!configured) {
                    throw new Error('Repository not found: shared.repository.client-state-snapshots');
                }
                return stateCache.readClientSnapshots();
            }
        });
        const events: string[] = [];
        const stopRooms = roomStateStore.onChange(() => {
            events.push('rooms');
        });
        const stopPeople = stateStore.onPeopleChange(() => {
            events.push('people');
        });
        expect(events).toEqual([]);

        configured = true;
        stateStore.emit();
        expect(events).toEqual(['rooms', 'people']);
        stopRooms();
        stopPeople();
        stateStore.emit();
        expect(events).toEqual(['rooms', 'people']);
    });

    it('skips emitting while the snapshot repositories are unconfigured', () => {
        // Disconnect and logout emit state, and both run before a first connect
        // configures the browser caches.
        const events: string[] = [];
        const { stateStore } = createStateStoreFixture(
            createFailingCacheReads('Repository not found: shared.repository.group-state-snapshots')
        );
        stateStore.onPeopleChange(() => {
            events.push('people');
        }, { emitCurrent: false });
        stateStore.onAfterEmit(() => {
            events.push('derived');
        });

        expect(() => stateStore.emit()).not.toThrow();
        expect(events).toEqual([]);
    });

    it('rethrows emit failures that are not a missing repository', () => {
        const { stateStore } = createStateStoreFixture(createFailingCacheReads('boom'));

        expect(() => stateStore.emit()).toThrow('boom');
    });
});

interface StateStoreFixture {
    readonly roomStateStore: RoomStateStore;
    readonly stateCache: RallarStateCacheReadPort;
    readonly stateStore: RallarStateStore;
}

function createStateStoreFixture(
    cacheOverrides: Partial<RallarStateCacheReadPort> = {},
    readSession: () => AuthSession | undefined = () => undefined
): StateStoreFixture {
    const runtime = new BrowserFacadeRuntimeState(new BrowserTransportRuntime({ openSessionChannelPort: () => undefined }));
    const stateCache: RallarStateCacheReadPort = {
        ...createRallarStateCacheReadPort(),
        ...cacheOverrides
    };
    const roomStateStore = new RoomStateStore({
        runtime,
        readSession,
        stateCache
    });
    const stateStore = new RallarStateStore({
        runtime,
        roomStateStore,
        stateCache
    });
    return { roomStateStore, stateCache, stateStore };
}

/** Mirrors the browser caches before a first connect configures them. */
function createFailingCacheReads(message: string): Partial<RallarStateCacheReadPort> {
    const fail = (): never => {
        throw new Error(message);
    };
    return {
        readGroupSnapshots: fail,
        findGroupSnapshotByRef: fail,
        findFirstGroupRefForSession: fail,
        readClientSnapshots: fail,
        findClientSnapshot: fail
    };
}

function writeStateRevision(revision: number): void {
    const group = createGroupSnapshotFixture({
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'room-1',
        sessionIds: []
    });
    setGroupStateSnapshots([{
        ...group,
        causalRevision: { ...group.causalRevision, groupRevision: revision },
        group: { ...group.group, displayName: String(revision), snapshotVersion: revision, metadataVersion: revision }
    }]);
    const client = createClientSnapshotFixture({
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        principalId: 'alice'
    });
    setClientStateSnapshots([{
        ...client,
        stateRevision: revision,
        principal: { ...client.principal, displayName: String(revision), snapshotVersion: revision, profileVersion: revision }
    }]);
}
