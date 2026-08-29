import { BrowserFacadeRuntimeState } from '@shared-web/browser/composition/browser-facade-runtime-state.ts';
import { BrowserTransportRuntime } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import { createRoomStateStore } from '@shared-web/browser/rooms/room-state-store.ts';
import { createRallarStateCacheReadPort, RallarStateStore, type RallarStateCacheReadPort } from '@shared-web/browser/state-cache/rallar-state-store.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import { configureTestCacheRepositories } from '../../cache-repository-config.ts';

describe('Rallar state store', () => {
    beforeEach(() => {
        configureTestCacheRepositories();
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

    it('exposes cache observation through the cache port', () => {
        const { stateCache } = createStateStoreFixture();

        const unsubscribe = stateCache.onCacheChange(() => undefined);
        expect(unsubscribe).toBeTypeOf('function');
        unsubscribe();
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

function createStateStoreFixture(
    cacheOverrides: Partial<RallarStateCacheReadPort> = {}
) {
    const runtime = new BrowserFacadeRuntimeState(new BrowserTransportRuntime());
    const stateCache: RallarStateCacheReadPort = {
        ...createRallarStateCacheReadPort(),
        ...cacheOverrides
    };
    const roomStateStore = createRoomStateStore({
        runtime,
        readSession: () => undefined,
        stateCache
    });
    const stateStore = new RallarStateStore({
        runtime,
        roomStateStore,
        readSession: () => undefined,
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
