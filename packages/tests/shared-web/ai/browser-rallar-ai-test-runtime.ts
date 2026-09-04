import type { RallarDataStoreOptions } from '@shared-web/browser/rallar-data.ts';
import type { RallarMessageSendResult, RallarRealtimeJsonSendInput, RallarRtcSendInput, RallarWsSendInput } from '@shared-web/browser/rallar.ts';
import { vi } from 'vitest';

export function createFakeRallar() {
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
                    async <TValue>(_input: RallarRtcSendInput<TValue>) => createFakeMessageSendResult('rtc')
                ),
                onMessage: () => noopUnsubscribe
            },
            ws: {
                send: vi.fn(
                    async <TValue>(_input: RallarWsSendInput<TValue>) => createFakeMessageSendResult('ws')
                ),
                onMessage: () => noopUnsubscribe
            },
            channel: unusedByBrowserAi,
            room: unusedByBrowserAi
        }
    };
}

function createFakeDataStore() {
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

function createFakeMessageSendResult(
    transport: 'rtc' | 'ws'
): RallarMessageSendResult {
    return {
        transport,
        status: 'enqueued',
        message: {
            id: {
                v: 2,
                msgId: `${transport}-message-1`,
                ts: 1_000,
                senderId: 'peer-a'
            },
            route: {
                topicId: 'room.ai',
                resourceId: 'result-1',
                contextId: 'room-1'
            },
            payload: {
                typeId: 'generated',
                contentType: 'application/json',
                resource: '{}'
            }
        },
        entries: []
    };
}

function noopUnsubscribe(): void {}

function unusedByBrowserAi(): never {
    throw new Error('member is not exercised by the browser AI facade');
}
