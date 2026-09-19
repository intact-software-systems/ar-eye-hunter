import type { RallarDataFacade, RallarDataStore, RallarDataStoreOptions } from '@shared-web/browser/rallar-data.ts';
import type { RallarFacade, RallarRealtimeJsonSendInput, RallarRtcSendInput, RallarWsSendInput } from '@shared-web/browser/rallar.ts';
import { vi } from 'vitest';
import { createMessageDelivery } from '../messages/test-message-delivery.ts';

export function createFakeRallar(): FakeBrowserAiRallar {
    const store = createFakeDataStore();
    return {
        store,
        data: {
            open: vi.fn(
                async (
                    _input: string,
                    _options?: Pick<RallarDataStoreOptions<never>, 'durability' | 'scope'>
                ) => store
            ),
            define: unusedByBrowserAi,
            lookup: () => undefined,
            close: async () => false,
            closeScope: async () => 0,
            clearScope: async () => 0,
            destroy: async () => false,
            destroyScope: async () => 0,
            estimateUsage: async () => ({})
        },
        realtime: {
            sendJson: vi.fn(
                async <TValue>(_input: RallarRealtimeJsonSendInput<TValue>) => []
            ),
            sendBinary: async () => [],
            onJson: () => noopUnsubscribe,
            onBinary: () => noopUnsubscribe,
            json: unusedByBrowserAi,
            room: unusedByBrowserAi,
            health: () => []
        },
        messages: {
            rtc: {
                send: vi.fn(
                    async <TValue>(_input: RallarRtcSendInput<TValue>) =>
                        createMessageDelivery('rtc', { kind: 'admitted', durable: true, queuedAttempts: 1 }).handle
                ),
                onMessage: () => noopUnsubscribe
            },
            ws: {
                send: vi.fn(
                    async <TValue>(_input: RallarWsSendInput<TValue>) =>
                        createMessageDelivery('ws', { kind: 'admitted', durable: true, queuedAttempts: 1 }).handle
                ),
                onMessage: () => noopUnsubscribe
            },
            channel: unusedByBrowserAi,
            room: unusedByBrowserAi
        }
    };
}

function createFakeDataStore(): RallarDataStore<never> {
    return {
        name: 'rallar-ai-results',
        repositoryId: 'rallar-ai-results',
        hydrate: async () => undefined,
        whenHydrated: async () => undefined,
        isHydrated: () => true,
        whenIdle: async () => undefined,
        flush: async () => undefined,
        read: (_key: string) => undefined,
        get: async (_key: string) => undefined,
        readEntries: () => [],
        readAllValues: () => [],
        getEntries: async () => [],
        getAll: async () => [],
        listKeys: async () => [],
        keys: () => [],
        exportData: async () => ({}),
        set: vi.fn(async <TValue>(_key: string, _value: TValue) => undefined),
        update: async (_key: string) => undefined,
        updateOrCreate: unusedByBrowserAi,
        setIfAbsent: unusedByBrowserAi,
        compareAndSet: async (_key: string) => false,
        getAndSet: async (_key: string) => undefined,
        delete: async (_key: string) => false,
        deleteExpired: async () => 0,
        clear: async () => undefined,
        clearAll: async () => undefined,
        close: async () => false,
        destroy: async () => undefined,
        estimateUsage: async () => ({}),
        onChange: () => noopUnsubscribe
    };
}

function noopUnsubscribe(): void {}

function unusedByBrowserAi(): never {
    throw new Error('member is not exercised by the browser AI facade');
}

export interface FakeBrowserAiRallar {
    readonly store: RallarDataStore<never>;
    readonly data: RallarDataFacade;
    readonly realtime: RallarFacade['realtime'];
    readonly messages: RallarFacade['messages'];
}
