import { createRallarBrowserFacadeRuntimeContext } from '@shared-web/browser/rallar-runtime-context.ts';
import { createRallarLifecycleCoordinator, type RallarLifecycleParticipant } from '@shared-web/browser/rallar-runtime/lifecycle.ts';
import { createRallarStateCacheReadPort, createRallarStateStore } from '@shared-web/browser/rallar-runtime/state-store.ts';
import { createRallarSubscriptionScope } from '@shared-web/browser/rallar-runtime/subscriptions.ts';
import { createRallarWsInbox } from '@shared-web/browser/rallar-runtime/ws-inbox.ts';
import { createRallarFacade } from '@shared-web/browser/rallar.ts';
import { createRoomStateStore } from '@shared-web/browser/rooms/room-state-store.ts';
import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';

import { configureTestCacheRepositories } from '../cache-repository-config.ts';

describe('Rallar browser runtime foundations', () => {
    it('isolates composed facade defaults between instances', () => {
        const first = createRallarFacade();
        const second = createRallarFacade();

        first.setDefaults({ applicationId: 'isolated-app' });

        expect(first.defaults()?.applicationId).toBe('isolated-app');
        expect(second.defaults()).toBeUndefined();
    });

    it('runs every lifecycle phase in ascending participant order', () => {
        const events: string[] = [];
        const lifecycle = createRallarLifecycleCoordinator();
        const participant = (id: string, order: number): RallarLifecycleParticipant => ({
            id,
            order,
            attach: () => events.push(`attach:${id}`),
            connected: () => events.push(`connected:${id}`),
            detach: () => events.push(`detach:${id}`),
            disconnected: () => events.push(`disconnected:${id}`)
        });

        lifecycle.register(participant('rtc', 60));
        lifecycle.register(participant('state', 20));
        lifecycle.register(participant('messages', 30));

        lifecycle.attach({} as never);
        lifecycle.connected();
        lifecycle.detach({} as never);
        lifecycle.disconnected();

        expect(events).toEqual([
            'attach:state',
            'attach:messages',
            'attach:rtc',
            'connected:state',
            'connected:messages',
            'connected:rtc',
            'detach:state',
            'detach:messages',
            'detach:rtc',
            'disconnected:state',
            'disconnected:messages',
            'disconnected:rtc'
        ]);
    });

    it('rejects duplicate lifecycle participant ids', () => {
        const lifecycle = createRallarLifecycleCoordinator();
        lifecycle.register({ id: 'state', order: 20 });

        expect(() => lifecycle.register({ id: 'state', order: 30 })).toThrow(
            'Duplicate Rallar lifecycle participant: state'
        );
    });

    it('cleans subscription scopes once and immediately cleans late additions', () => {
        const calls: string[] = [];
        const subscriptions = createRallarSubscriptionScope();
        subscriptions.add(() => calls.push('first'));
        subscriptions.add(undefined);
        subscriptions.add(() => calls.push('second'));

        expect(subscriptions.size()).toBe(2);
        subscriptions.unsubscribe();
        subscriptions.unsubscribe();
        subscriptions.add(() => calls.push('late'));

        expect(calls).toEqual(['first', 'second', 'late']);
        expect(subscriptions.size()).toBe(0);
    });

    it('emits room, people, then derived state observers', () => {
        const events: string[] = [];
        const state = createFoundationStateStore();
        state.onRoomChange(() => {
            events.push('rooms');
        }, { emitCurrent: false });
        state.onPeopleChange(() => {
            events.push('people');
        }, { emitCurrent: false });
        state.onAfterEmit(() => events.push('derived'));

        state.emit();

        expect(events).toEqual(['rooms', 'people', 'derived']);
    });

    it('exposes cache observation through the state port', () => {
        const state = createFoundationStateStore();

        expect(state).toHaveProperty('onCacheChange', expect.any(Function));
        const unsubscribe = state.onCacheChange(() => undefined);
        expect(unsubscribe).toBeTypeOf('function');
        unsubscribe();
    });

    it('multiplexes one WS callback and dispatches handlers in order', async () => {
        const events: string[] = [];
        let onMessage: ((message: unknown) => Promise<void>) | undefined;
        const queueBox = {
            onAnyInboxMessageDo: vi.fn((_id, callbacks) => {
                onMessage = callbacks.onMessage;
            }),
            removeAnyInboxMessageCallback: vi.fn()
        };
        const ctx = { middleware: { webSocketQueueBox: queueBox } } as never;
        const inbox = createRallarWsInbox({ readMiddleware: () => ctx });

        const stopMessages = inbox.subscribe({
            id: 'messages',
            order: 20,
            onMessage: async () => {
                events.push('messages');
            }
        });
        const stopState = inbox.subscribe({
            id: 'state-events',
            order: 10,
            onMessage: async () => {
                events.push('state-events');
            }
        });

        expect(queueBox.onAnyInboxMessageDo).toHaveBeenCalledTimes(1);
        await onMessage?.({});
        expect(events).toEqual(['state-events', 'messages']);

        stopState();
        expect(queueBox.removeAnyInboxMessageCallback).not.toHaveBeenCalled();
        stopMessages();
        expect(queueBox.removeAnyInboxMessageCallback).toHaveBeenCalledTimes(1);
    });
});

function createFoundationStateStore() {
    configureTestCacheRepositories();
    const runtime = createRallarBrowserFacadeRuntimeContext();
    const roomStateStore = createRoomStateStore({
        runtime,
        readSession: () => undefined,
        stateCache: createRallarStateCacheReadPort()
    });
    return createRallarStateStore({
        runtime,
        roomStateStore,
        readSession: () => undefined,
        stateCache: createRallarStateCacheReadPort()
    });
}
