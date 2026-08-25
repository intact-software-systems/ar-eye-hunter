import { BrowserTransportRuntime } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import { BrowserFacadeRuntimeState } from '@shared-web/browser/rallar-runtime-context.ts';
import { createRallarLifecycleCoordinator, type RallarLifecycleParticipant } from '@shared-web/browser/rallar-runtime/lifecycle.ts';
import { createRallarStateCacheReadPort, RallarStateStore } from '@shared-web/browser/rallar-runtime/state-store.ts';
import { BrowserRallarSubscriptionScope } from '@shared-web/browser/rallar-runtime/subscriptions.ts';
import { createBrowserWebSocketInbox } from '@shared-web/browser/websocket/browser-websocket-inbox.ts';
import { createRallarFacade } from '@shared-web/browser/rallar.ts';
import { createRoomStateStore } from '@shared-web/browser/rooms/room-state-store.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';

import { configureTestCacheRepositories } from '../cache-repository-config.ts';

const wsInboxTestMessage: ALMessage = {
    id: {
        v: 2,
        msgId: 'message-1',
        ts: 1,
        senderId: 'sender-1'
    },
    route: {
        topicId: 'test.message',
        contextId: 'test-context',
        resourceId: 'test-resource'
    },
    payload: {
        typeId: 'test.message',
        contentType: 'application/json',
        resource: '{}'
    }
};

interface WsInboxCallbacks {
    onMessage(message: ALMessage): Promise<void>;
}

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
        const subscriptions = new BrowserRallarSubscriptionScope();
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
        const { roomStateStore, stateStore } = createFoundationStateStore();
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
        const { stateCache } = createFoundationStateStore();

        const unsubscribe = stateCache.onCacheChange(() => undefined);
        expect(unsubscribe).toBeTypeOf('function');
        unsubscribe();
    });

    it('multiplexes one WS callback and dispatches handlers in order', async () => {
        const events: string[] = [];
        let onMessage: ((message: ALMessage) => Promise<void>) | undefined;
        const subscriptionEvents: string[] = [];
        const queueBox = {
            onAnyInboxMessageDo: (_id: string, callbacks: WsInboxCallbacks) => {
                subscriptionEvents.push('attached');
                onMessage = callbacks.onMessage;
            },
            removeAnyInboxMessageCallback: () => {
                subscriptionEvents.push('removed');
            }
        };
        const ctx = { middleware: { webSocketQueueBox: queueBox } } as never;
        const inbox = createBrowserWebSocketInbox({ readMiddleware: () => ctx });

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

        expect(subscriptionEvents).toEqual(['attached']);
        await onMessage?.(wsInboxTestMessage);
        expect(events).toEqual(['state-events', 'messages']);

        stopState();
        expect(subscriptionEvents).toEqual(['attached']);
        stopMessages();
        expect(subscriptionEvents).toEqual(['attached', 'removed']);
    });
});

function createFoundationStateStore() {
    configureTestCacheRepositories();
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
