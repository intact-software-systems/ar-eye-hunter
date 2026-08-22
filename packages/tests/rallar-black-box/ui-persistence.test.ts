import { describe, expect, it } from 'vitest';
import { DEFAULT_MANUAL_WORKBENCH_VALUES } from '../../../apps/rallar-black-box/src/manual-workbench.ts';
import {
    readManualWorkbenchDraft,
    readRallarServerWorkbenchDraft,
    readStoredAppMode,
    readStoredAppTab,
    sanitizeManualWorkbenchDraft,
    sanitizeRallarServerWorkbenchDraft,
    UI_STORAGE_KEYS,
    writeManualWorkbenchDraft,
    writeRallarServerWorkbenchDraft,
    writeStoredAppMode,
    writeStoredAppTab,
    type RallarBlackBoxUiStorage
} from '../../../apps/rallar-black-box/src/ui-persistence.ts';

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

        const sanitized = sanitizeManualWorkbenchDraft(draft, ['payload-token']);

        expect(JSON.stringify(sanitized)).not.toContain('manual-password');
        expect(JSON.stringify(sanitized)).not.toContain('payload-token');
        expect(sanitized.payloadText).toContain('<redacted>');
    });

    it('restores Manual Rallar drafts without taking passwords from storage', () => {
        const storage = new MemoryStorage();
        writeManualWorkbenchDraft(storage, {
            values: {
                ...DEFAULT_MANUAL_WORKBENCH_VALUES,
                groupId: 'persisted-room',
                rallarPassword: 'persisted-password'
            },
            payloadPresetId: 'custom',
            payloadText: '{"kind":"ping"}'
        });

        const restored = readManualWorkbenchDraft(storage, {
            values: {
                ...DEFAULT_MANUAL_WORKBENCH_VALUES,
                rallarPassword: 'bootstrap-password'
            },
            payloadPresetId: 'ping',
            payloadText: '{"kind":"default"}'
        });

        expect(storage.getItem(UI_STORAGE_KEYS.manualDraft)).not.toContain('persisted-password');
        expect(restored?.values.groupId).toBe('persisted-room');
        expect(restored?.values.rallarPassword).toBe('bootstrap-password');
    });

    it('redacts Rallar Server request draft headers, query, and body before storage', () => {
        const storage = new MemoryStorage();
        const draft = {
            apiBaseUrl: 'http://localhost:8080',
            selectedPresetId: 'custom',
            method: 'POST' as const,
            path: '/api/example',
            headersText: JSON.stringify({
                authorization: 'Bearer secret-token'
            }),
            queryText: JSON.stringify({
                access_token: 'query-token'
            }),
            bodyText: JSON.stringify({
                password: 'body-password',
                nested: {
                    apiKey: 'body-key'
                }
            }),
            responseBodyMode: 'json' as const,
            attachAuth: true,
            timeoutMs: 5000
        };

        writeRallarServerWorkbenchDraft(storage, draft, ['secret-token']);

        const raw = storage.getItem(UI_STORAGE_KEYS.rallarServerDraft) ?? '';
        expect(raw).not.toContain('secret-token');
        expect(raw).not.toContain('query-token');
        expect(raw).not.toContain('body-password');
        expect(raw).not.toContain('body-key');
        expect(raw).toContain('<redacted>');

        const restored = readRallarServerWorkbenchDraft(storage, draft);
        expect(restored?.path).toBe('/api/example');
        expect(restored?.bodyText).toContain('<redacted>');
    });

    it('drops invalid JSON editor text instead of persisting possible secrets', () => {
        const sanitized = sanitizeRallarServerWorkbenchDraft({
            apiBaseUrl: 'http://localhost:8080',
            selectedPresetId: 'custom',
            method: 'POST',
            path: '/api/example',
            headersText: 'authorization: Bearer secret-token',
            queryText: '{',
            bodyText: 'password=secret',
            responseBodyMode: 'json',
            attachAuth: true,
            timeoutMs: 5000
        }, ['secret-token']);

        expect(sanitized.headersText).toBe('');
        expect(sanitized.queryText).toBe('');
        expect(sanitized.bodyText).toBe('');
    });
});
