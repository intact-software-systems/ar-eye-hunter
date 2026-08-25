import { BrowserFacadeRuntimeState } from '@shared-web/browser/composition/browser-facade-runtime-state.ts';
import { BrowserTransportRuntime } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import { createRoomStateStore } from '@shared-web/browser/rooms/room-state-store.ts';
import { createRallarStateCacheReadPort, RallarStateStore } from '@shared-web/browser/state-cache/rallar-state-store.ts';
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
});

function createStateStoreFixture() {
    const runtime = new BrowserFacadeRuntimeState(new BrowserTransportRuntime());
    const stateCache = createRallarStateCacheReadPort();
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
