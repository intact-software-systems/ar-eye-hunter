import { describe, expect, it } from 'vitest';
import { DEFAULT_MANUAL_WORKBENCH_VALUES } from '../../../apps/rallar-black-box/src/manual-workbench.ts';
import {
    readStoredAppMode,
    readStoredAppTab,
    writeStoredAppMode,
    writeStoredAppTab
} from '../../../apps/rallar-black-box/src/ui-cache/app-shell-preferences.ts';
import {
    readStoredEventFilters,
    writeStoredEventFilters
} from '../../../apps/rallar-black-box/src/ui-cache/event-filters.ts';
import {
    readStoredManualWorkbenchDraft,
    toStoredManualWorkbenchDraft,
    writeStoredManualWorkbenchDraft
} from '../../../apps/rallar-black-box/src/ui-cache/manual-workbench-draft.ts';
import {
    UI_STORAGE_KEYS,
    type RallarBlackBoxUiStorage
} from '../../../apps/rallar-black-box/src/ui-cache/rallar-black-box-ui-storage.ts';
import {
    readStoredRallarServerRestCollectionDraft,
    readStoredRallarServerWorkbenchDraft,
    toStoredRallarServerWorkbenchDraft,
    writeStoredRallarServerRestCollectionDraft,
    writeStoredRallarServerWorkbenchDraft
} from '../../../apps/rallar-black-box/src/ui-cache/rallar-server-drafts.ts';

class MemoryStorage implements RallarBlackBoxUiStorage {
    private readonly values = new Map<string, string>();

    getItem(key: string): string | null {
        return this.values.get(key) ?? null;
    }

    setItem(key: string, value: string): void {
        this.values.set(key, value);
    }

    removeItem(key: string): void {
        this.values.delete(key);
    }
}

const SESSION_VALUES = {
    providerMode: DEFAULT_MANUAL_WORKBENCH_VALUES.providerMode,
    rallarPassword: 'bootstrap-password'
};

const RALLAR_SERVER_DRAFT = {
    apiBaseUrl: 'http://localhost:8080',
    selectedPresetId: 'custom',
    method: 'POST' as const,
    path: '/api/example',
    headersText: JSON.stringify({ authorization: 'Bearer secret-token' }),
    queryText: JSON.stringify({ access_token: 'query-token' }),
    bodyText: JSON.stringify({ password: 'body-password', nested: { apiKey: 'body-key' } }),
    responseBodyMode: 'json' as const,
    attachAuth: true,
    timeoutMs: 5000
};

const REST_COLLECTION = {
    collectionId: 'demo',
    name: 'Demo collection',
    steps: [
        {
            stepId: 'health',
            label: 'Health',
            request: { method: 'GET' as const, path: '/health' }
        }
    ]
};

describe('rallar-black-box UI persistence', () => {
    it('stores the active tab as a small non-secret preference', () => {
        const storage = new MemoryStorage();

        writeStoredAppTab(storage, 'rallar-server');

        expect(readStoredAppTab(storage)).toBe('rallar-server');
        expect(storage.getItem(UI_STORAGE_KEYS.activeTab)).toBe('rallar-server');
    });

    it('stores the active workspace mode as a small non-secret preference', () => {
        const storage = new MemoryStorage();

        writeStoredAppMode(storage, 'black-box-runner');

        expect(readStoredAppMode(storage)).toBe('black-box-runner');
        expect(storage.getItem(UI_STORAGE_KEYS.activeMode)).toBe('black-box-runner');
    });

    it('removes Manual Rallar passwords and redacts persisted payload drafts', () => {
        const draft = {
            values: {
                ...DEFAULT_MANUAL_WORKBENCH_VALUES,
                groupId: 'draft-room',
                rallarUsername: 'alice',
                rallarPassword: 'manual-password'
            },
            payloadPresetId: 'custom',
            payloadText: JSON.stringify({
                token: 'payload-token',
                nested: {
                    password: 'payload-password'
                }
            })
        };

        const stored = toStoredManualWorkbenchDraft(draft, ['payload-token']);

        expect(JSON.stringify(stored)).not.toContain('manual-password');
        expect(JSON.stringify(stored)).not.toContain('payload-token');
        expect(JSON.stringify(stored)).toContain('<redacted>');
    });

    it('restores Manual Rallar drafts without taking passwords from storage', () => {
        const storage = new MemoryStorage();
        writeStoredManualWorkbenchDraft(storage, {
            values: {
                ...DEFAULT_MANUAL_WORKBENCH_VALUES,
                groupId: 'persisted-room',
                rallarPassword: 'persisted-password'
            },
            payloadPresetId: 'custom',
            payloadText: '{"kind":"ping"}'
        }, []);

        const restored = readStoredManualWorkbenchDraft(storage, SESSION_VALUES);

        expect(storage.getItem(UI_STORAGE_KEYS.manualDraft)).not.toContain('persisted-password');
        expect(restored?.values.groupId).toBe('persisted-room');
        expect(restored?.values.rallarPassword).toBe('bootstrap-password');
        expect(restored?.values.providerMode).toBe(DEFAULT_MANUAL_WORKBENCH_VALUES.providerMode);
    });

    it('discards a Manual Rallar entry whose cached value has the wrong type', () => {
        const storage = new MemoryStorage();
        writeStoredManualWorkbenchDraft(storage, {
            values: { ...DEFAULT_MANUAL_WORKBENCH_VALUES, groupId: 'persisted-room' },
            payloadPresetId: 'custom',
            payloadText: '{"kind":"ping"}'
        }, []);
        const stored = JSON.parse(storage.getItem(UI_STORAGE_KEYS.manualDraft) ?? '{}');
        storage.setItem(
            UI_STORAGE_KEYS.manualDraft,
            JSON.stringify({ ...stored, values: { ...stored.values, timeoutMs: 'not-a-number' } })
        );

        expect(readStoredManualWorkbenchDraft(storage, SESSION_VALUES)).toBeUndefined();
    });

    it('discards a Manual Rallar entry that is missing a cached value', () => {
        const storage = new MemoryStorage();
        storage.setItem(
            UI_STORAGE_KEYS.manualDraft,
            JSON.stringify({ values: { groupId: 'persisted-room' }, payloadPresetId: 'custom', payloadText: '{}' })
        );

        expect(readStoredManualWorkbenchDraft(storage, SESSION_VALUES)).toBeUndefined();
    });

    it('redacts Rallar Server request draft headers, query, and body before storage', () => {
        const storage = new MemoryStorage();

        writeStoredRallarServerWorkbenchDraft(storage, RALLAR_SERVER_DRAFT, ['secret-token']);

        const raw = storage.getItem(UI_STORAGE_KEYS.rallarServerDraft) ?? '';
        expect(raw).not.toContain('secret-token');
        expect(raw).not.toContain('query-token');
        expect(raw).not.toContain('body-password');
        expect(raw).not.toContain('body-key');
        expect(raw).toContain('<redacted>');

        const restored = readStoredRallarServerWorkbenchDraft(storage);
        expect(restored?.path).toBe('/api/example');
        expect(restored?.bodyText).toContain('<redacted>');
    });

    it('discards a Rallar Server request entry whose method is not a known method', () => {
        const storage = new MemoryStorage();
        writeStoredRallarServerWorkbenchDraft(storage, RALLAR_SERVER_DRAFT, []);
        const stored = JSON.parse(storage.getItem(UI_STORAGE_KEYS.rallarServerDraft) ?? '{}');
        storage.setItem(
            UI_STORAGE_KEYS.rallarServerDraft,
            JSON.stringify({ ...stored, method: 'PATCH' })
        );

        expect(readStoredRallarServerWorkbenchDraft(storage)).toBeUndefined();
    });

    it('restores a Rallar Server collection entry and discards one whose collection is not a collection', () => {
        const storage = new MemoryStorage();
        writeStoredRallarServerRestCollectionDraft(storage, {
            selectedCollectionId: 'demo',
            collection: REST_COLLECTION,
            variables: { baseUrl: 'http://localhost:8080' }
        }, []);

        expect(readStoredRallarServerRestCollectionDraft(storage)?.collection.collectionId).toBe('demo');

        storage.setItem(
            UI_STORAGE_KEYS.rallarServerCollectionDraft,
            JSON.stringify({ selectedCollectionId: 'demo', collection: { name: 'no id' }, variables: {} })
        );

        expect(readStoredRallarServerRestCollectionDraft(storage)).toBeUndefined();
    });

    it('drops invalid JSON editor text instead of persisting possible secrets', () => {
        const stored = toStoredRallarServerWorkbenchDraft({
            ...RALLAR_SERVER_DRAFT,
            headersText: 'authorization: Bearer secret-token',
            queryText: '{',
            bodyText: 'password=secret'
        }, ['secret-token']);

        expect(stored.headersText).toBe('');
        expect(stored.queryText).toBe('');
        expect(stored.bodyText).toBe('');
    });

    it('restores event filters and discards an entry whose filter is not text', () => {
        const storage = new MemoryStorage();
        const filters = {
            kind: 'rtc',
            commandId: 'all',
            connection: 'all',
            actor: 'all',
            transport: 'all',
            group: 'all',
            peer: 'all',
            selector: 'all',
            topic: 'all',
            severity: 'all'
        };
        writeStoredEventFilters(storage, filters);

        expect(readStoredEventFilters(storage)).toEqual(filters);

        storage.setItem(UI_STORAGE_KEYS.eventFilters, JSON.stringify({ ...filters, severity: 3 }));

        expect(readStoredEventFilters(storage)).toBeUndefined();
    });
});
