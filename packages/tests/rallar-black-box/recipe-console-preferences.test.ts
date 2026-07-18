import { describe, expect, it } from 'vitest';
import type { RecipeConsoleControlBootstrap } from
    '../../../apps/rallar-black-box/src/recipe-console/control/ControlConnectionProvider.tsx';
import {
    readRecipeConsolePreferences,
    RECIPE_CONSOLE_PREFERENCES_STORAGE_KEY,
    resetRecipeConsolePreferences,
    resolveRecipeConsolePreferenceState,
    writeRecipeConsolePreferences,
    type RecipeConsolePreferencesStorage,
} from '../../../apps/rallar-black-box/src/recipe-console/app/recipe-console-preferences.ts';

class MemoryStorage implements RecipeConsolePreferencesStorage {
    readonly values = new Map<string, string>();

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

function bootstrap(): RecipeConsoleControlBootstrap {
    return {
        controlUrl: 'wss://deployment-control.test/control',
        bootstrapRunId: 'run-a',
        apiBaseUrl: 'https://deployment-api.test',
        providerMode: 'simulated',
        manualToken: 'must-never-be-persisted',
        credentialPolicy: {
            allowManualToken: true,
            allowBrokeredToken: true,
            allowBootstrapAgentTicket: true,
            controlUrlFromLocation: false,
            apiBaseUrlFromLocation: false,
            controlTokenFromLocation: false,
        },
        bootstrapGroup: {
            applicationId: 'deployment-app',
            workspaceId: 'deployment-workspace',
            groupId: 'deployment-group',
        },
    };
}

const PERSONAL = {
    controlUrl: 'wss://personal.test/control',
    apiBaseUrl: 'https://api.personal.test',
    applicationId: 'personal-app',
    workspaceId: 'personal-workspace',
    groupId: 'personal-group',
    controlReadTimeoutMs: 20_000,
} as const;

describe('Recipe Console personal defaults', () => {
    it('round-trips only the versioned non-secret allow-list', () => {
        const storage = new MemoryStorage();

        writeRecipeConsolePreferences(storage, PERSONAL);

        expect(readRecipeConsolePreferences(storage)).toEqual(PERSONAL);
        expect(JSON.parse(
            storage.getItem(RECIPE_CONSOLE_PREFERENCES_STORAGE_KEY) ?? '{}',
        )).toEqual({
            version: 1,
            values: PERSONAL,
        });
        const raw = storage.getItem(RECIPE_CONSOLE_PREFERENCES_STORAGE_KEY) ?? '';
        expect(raw).not.toContain('must-never-be-persisted');
        expect(raw).not.toMatch(/password|token|sessionId|clientId|ticket/i);
    });

    it.each([
        ['https://user:secret@control.test', 'credentials'],
        ['https://control.test/?token=secret', 'query string'],
        ['https://control.test/#secret', 'fragment'],
        ['ftp://control.test', 'protocol'],
    ])('rejects a persisted endpoint containing %s', (controlUrl, expected) => {
        const storage = new MemoryStorage();

        expect(() => writeRecipeConsolePreferences(storage, {
            ...PERSONAL,
            controlUrl,
        })).toThrow(expected);
        expect(storage.getItem(RECIPE_CONSOLE_PREFERENCES_STORAGE_KEY)).toBeNull();
    });

    it.each([999, 120_001, 2_500.5, Number.NaN])(
        'rejects the invalid timeout %s',
        controlReadTimeoutMs => {
            expect(() => writeRecipeConsolePreferences(
                new MemoryStorage(),
                { ...PERSONAL, controlReadTimeoutMs },
            )).toThrow('Control read timeout');
        },
    );

    it('ignores malformed, unknown, and secret-shaped stored documents', () => {
        const storage = new MemoryStorage();
        const invalidDocuments = [
            '{',
            JSON.stringify({ version: 2, values: PERSONAL }),
            JSON.stringify({
                version: 1,
                values: { ...PERSONAL, token: 'secret' },
            }),
            JSON.stringify({
                version: 1,
                values: { ...PERSONAL, controlReadTimeoutMs: 500 },
            }),
        ];

        for (const document of invalidDocuments) {
            storage.setItem(RECIPE_CONSOLE_PREFERENCES_STORAGE_KEY, document);
            expect(readRecipeConsolePreferences(storage)).toEqual({
                controlReadTimeoutMs: 20_000,
            });
        }
    });

    it('applies personal values only when URL and deployment fields are absent', () => {
        const resolved = resolveRecipeConsolePreferenceState({
            bootstrap: bootstrap(),
            preferences: PERSONAL,
            search: '',
            env: {},
        });

        expect(resolved.effectiveBootstrap).toMatchObject({
            controlUrl: PERSONAL.controlUrl,
            apiBaseUrl: PERSONAL.apiBaseUrl,
            bootstrapGroup: {
                applicationId: PERSONAL.applicationId,
                workspaceId: PERSONAL.workspaceId,
                groupId: PERSONAL.groupId,
            },
        });
        expect(resolved.controlReadTimeoutMs).toBe(20_000);
        expect(resolved.locks).toEqual({});
    });

    it('locks each URL-owned field independently ahead of deployment and personal values', () => {
        const resolved = resolveRecipeConsolePreferenceState({
            bootstrap: bootstrap(),
            preferences: PERSONAL,
            search: '?controlUrl=wss%3A%2F%2Furl.test%2Fcontrol' +
                '&apiBaseUrl=https%3A%2F%2Furl-api.test' +
                '&applicationId=url-app&workspaceId=url-workspace&roomId=url-group',
            env: {
                VITE_RALLAR_CONTROL_URL: 'wss://environment.test/control',
                VITE_RALLAR_API_BASE_URL: 'https://environment-api.test',
                VITE_RALLAR_APPLICATION_ID: 'environment-app',
                VITE_RALLAR_WORKSPACE_ID: 'environment-workspace',
                VITE_RALLAR_ROOM_ID: 'environment-group',
            },
        });

        expect(resolved.effectiveBootstrap).toEqual(bootstrap());
        expect(resolved.locks).toEqual({
            controlUrl: 'url',
            apiBaseUrl: 'url',
            applicationId: 'url',
            workspaceId: 'url',
            groupId: 'url',
        });
    });

    it('locks deployment-owned fields and lets an unlocked field remain personal', () => {
        const resolved = resolveRecipeConsolePreferenceState({
            bootstrap: bootstrap(),
            preferences: PERSONAL,
            search: '',
            env: {
                VITE_RALLAR_CONTROL_URL: 'wss://environment.test/control',
                VITE_RALLAR_API_BASE_URL: 'https://environment-api.test',
                VITE_RALLAR_APPLICATION_ID: 'environment-app',
                VITE_RALLAR_WORKSPACE_ID: 'environment-workspace',
            },
        });

        expect(resolved.effectiveBootstrap.bootstrapGroup.groupId)
            .toBe('personal-group');
        expect(resolved.locks).toEqual({
            controlUrl: 'deployment',
            apiBaseUrl: 'deployment',
            applicationId: 'deployment',
            workspaceId: 'deployment',
        });
    });

    it('removes the versioned document on reset', () => {
        const storage = new MemoryStorage();
        writeRecipeConsolePreferences(storage, PERSONAL);

        resetRecipeConsolePreferences(storage);

        expect(storage.getItem(RECIPE_CONSOLE_PREFERENCES_STORAGE_KEY)).toBeNull();
        expect(readRecipeConsolePreferences(storage)).toEqual({
            controlReadTimeoutMs: 20_000,
        });
    });
});
