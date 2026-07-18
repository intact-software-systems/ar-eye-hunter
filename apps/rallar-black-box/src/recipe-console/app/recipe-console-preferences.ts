import type { RecipeConsoleControlBootstrap } from
    '../control/ControlConnectionProvider.tsx';
import { CONTROL_QUERY_DEFAULT_REQUEST_TIMEOUT_MS } from
    '../control/ControlConnectionProvider.tsx';

export const RECIPE_CONSOLE_PREFERENCES_STORAGE_KEY =
    'rallar.black-box.recipe-console.preferences.v1';

const PREFERENCE_VERSION = 1 as const;
const MIN_CONTROL_READ_TIMEOUT_MS = 1_000;
const MAX_CONTROL_READ_TIMEOUT_MS = 120_000;
const MAX_CONTEXT_VALUE_LENGTH = 256;
const ENDPOINT_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);
const VALUE_KEYS = [
    'controlUrl',
    'apiBaseUrl',
    'applicationId',
    'workspaceId',
    'groupId',
    'controlReadTimeoutMs',
] as const;

type PreferenceField = typeof VALUE_KEYS[number];
export type RecipeConsoleManagedPreferenceField = Exclude<
    PreferenceField,
    'controlReadTimeoutMs'
>;

export type RecipeConsolePreferences = Readonly<{
    controlUrl?: string;
    apiBaseUrl?: string;
    applicationId?: string;
    workspaceId?: string;
    groupId?: string;
    controlReadTimeoutMs: number;
}>;

export type RecipeConsolePreferenceLocks = Readonly<Partial<Record<
    RecipeConsoleManagedPreferenceField,
    'url' | 'deployment'
>>>;

export type RecipeConsolePreferenceState = Readonly<{
    effectiveBootstrap: RecipeConsoleControlBootstrap;
    values: Required<RecipeConsolePreferences>;
    locks: RecipeConsolePreferenceLocks;
    controlReadTimeoutMs: number;
}>;

export type RecipeConsolePreferencesStorage = Pick<
    Storage,
    'getItem' | 'setItem' | 'removeItem'
>;

type StoredRecipeConsolePreferences = Readonly<{
    version: typeof PREFERENCE_VERSION;
    values: RecipeConsolePreferences;
}>;

export class RecipeConsolePreferenceValidationError extends Error {
    readonly field: PreferenceField;

    constructor(field: PreferenceField, message: string) {
        super(message);
        this.name = 'RecipeConsolePreferenceValidationError';
        this.field = field;
    }
}

export function readRecipeConsolePreferences(
    storage: RecipeConsolePreferencesStorage,
): RecipeConsolePreferences {
    try {
        const raw = storage.getItem(RECIPE_CONSOLE_PREFERENCES_STORAGE_KEY);
        if (!raw) return defaultPreferences();
        const document = JSON.parse(raw) as unknown;
        const parsed = parseStoredPreferences(document);
        return parsed ?? defaultPreferences();
    } catch (_error) {
        return defaultPreferences();
    }
}

export function writeRecipeConsolePreferences(
    storage: RecipeConsolePreferencesStorage,
    preferences: RecipeConsolePreferences,
): RecipeConsolePreferences {
    const values = parsePreferenceValues(preferences, true);
    const document: StoredRecipeConsolePreferences = {
        version: PREFERENCE_VERSION,
        values,
    };
    storage.setItem(
        RECIPE_CONSOLE_PREFERENCES_STORAGE_KEY,
        JSON.stringify(document),
    );
    return values;
}

export function resetRecipeConsolePreferences(
    storage: RecipeConsolePreferencesStorage,
): void {
    storage.removeItem(RECIPE_CONSOLE_PREFERENCES_STORAGE_KEY);
}

export function resolveRecipeConsolePreferenceState(input: Readonly<{
    bootstrap: RecipeConsoleControlBootstrap;
    preferences: RecipeConsolePreferences;
    search: string;
    env: Readonly<Record<string, string | undefined>>;
}>): RecipeConsolePreferenceState {
    const params = new URLSearchParams(
        input.search.startsWith('?') ? input.search.slice(1) : input.search,
    );
    const locks: Partial<Record<
        RecipeConsoleManagedPreferenceField,
        'url' | 'deployment'
    >> = {};
    const sources = {
        controlUrl: ['controlUrl', 'VITE_RALLAR_CONTROL_URL'],
        apiBaseUrl: ['apiBaseUrl', 'VITE_RALLAR_API_BASE_URL'],
        applicationId: ['applicationId', 'VITE_RALLAR_APPLICATION_ID'],
        workspaceId: ['workspaceId', 'VITE_RALLAR_WORKSPACE_ID'],
        groupId: ['roomId', 'VITE_RALLAR_ROOM_ID'],
    } as const;
    for (const field of Object.keys(sources) as RecipeConsoleManagedPreferenceField[]) {
        const [paramName, envName] = sources[field];
        if (params.get(paramName)?.trim()) locks[field] = 'url';
        else if (input.env[envName]?.trim()) locks[field] = 'deployment';
    }

    const controlUrl = effectiveValue(
        input.bootstrap.controlUrl ?? '',
        input.preferences.controlUrl,
        locks.controlUrl,
    );
    const apiBaseUrl = effectiveValue(
        input.bootstrap.apiBaseUrl,
        input.preferences.apiBaseUrl,
        locks.apiBaseUrl,
    );
    const applicationId = effectiveValue(
        input.bootstrap.bootstrapGroup.applicationId,
        input.preferences.applicationId,
        locks.applicationId,
    );
    const workspaceId = effectiveValue(
        input.bootstrap.bootstrapGroup.workspaceId,
        input.preferences.workspaceId,
        locks.workspaceId,
    );
    const groupId = effectiveValue(
        input.bootstrap.bootstrapGroup.groupId,
        input.preferences.groupId,
        locks.groupId,
    );
    const effectiveBootstrap: RecipeConsoleControlBootstrap = {
        ...input.bootstrap,
        controlUrl,
        apiBaseUrl,
        bootstrapGroup: {
            applicationId,
            workspaceId,
            groupId,
        },
    };

    return {
        effectiveBootstrap,
        values: {
            controlUrl,
            apiBaseUrl,
            applicationId,
            workspaceId,
            groupId,
            controlReadTimeoutMs: input.preferences.controlReadTimeoutMs,
        },
        locks,
        controlReadTimeoutMs: input.preferences.controlReadTimeoutMs,
    };
}

function parseStoredPreferences(
    value: unknown,
): RecipeConsolePreferences | undefined {
    if (!isRecord(value) || value.version !== PREFERENCE_VERSION) {
        return undefined;
    }
    if (!isRecord(value.values) || hasUnknownKeys(value.values, VALUE_KEYS)) {
        return undefined;
    }
    try {
        return parsePreferenceValues(value.values, false);
    } catch (_error) {
        return undefined;
    }
}

function parsePreferenceValues(
    value: unknown,
    rejectUnknown: boolean,
): RecipeConsolePreferences {
    if (!isRecord(value)) {
        throw new RecipeConsolePreferenceValidationError(
            'controlReadTimeoutMs',
            'Personal defaults must be an object.',
        );
    }
    if (rejectUnknown && hasUnknownKeys(value, VALUE_KEYS)) {
        throw new RecipeConsolePreferenceValidationError(
            'controlReadTimeoutMs',
            'Personal defaults contain unsupported fields.',
        );
    }
    const timeout = value.controlReadTimeoutMs;
    if (
        typeof timeout !== 'number' ||
        !Number.isInteger(timeout) ||
        timeout < MIN_CONTROL_READ_TIMEOUT_MS ||
        timeout > MAX_CONTROL_READ_TIMEOUT_MS
    ) {
        throw new RecipeConsolePreferenceValidationError(
            'controlReadTimeoutMs',
            'Control read timeout must be an integer from 1000 through 120000 ms.',
        );
    }
    return removeUndefined({
        controlUrl: endpointValue(value.controlUrl, 'controlUrl'),
        apiBaseUrl: endpointValue(value.apiBaseUrl, 'apiBaseUrl'),
        applicationId: contextValue(value.applicationId, 'applicationId'),
        workspaceId: contextValue(value.workspaceId, 'workspaceId'),
        groupId: contextValue(value.groupId, 'groupId'),
        controlReadTimeoutMs: timeout,
    });
}

function endpointValue(
    value: unknown,
    field: 'controlUrl' | 'apiBaseUrl',
): string | undefined {
    const normalized = optionalString(value, field);
    if (!normalized) return undefined;
    let endpoint: URL;
    try {
        endpoint = new URL(normalized);
    } catch (_error) {
        throw new RecipeConsolePreferenceValidationError(
            field,
            `${fieldLabel(field)} must be a valid endpoint URL.`,
        );
    }
    if (!ENDPOINT_PROTOCOLS.has(endpoint.protocol)) {
        throw new RecipeConsolePreferenceValidationError(
            field,
            `${fieldLabel(field)} uses an unsupported protocol.`,
        );
    }
    if (endpoint.username || endpoint.password) {
        throw new RecipeConsolePreferenceValidationError(
            field,
            `${fieldLabel(field)} must not contain credentials.`,
        );
    }
    if (endpoint.search) {
        throw new RecipeConsolePreferenceValidationError(
            field,
            `${fieldLabel(field)} must not contain a query string.`,
        );
    }
    if (endpoint.hash) {
        throw new RecipeConsolePreferenceValidationError(
            field,
            `${fieldLabel(field)} must not contain a fragment.`,
        );
    }
    const serialized = endpoint.toString();
    return endpoint.pathname === '/'
        ? serialized.slice(0, -1)
        : serialized;
}

function contextValue(
    value: unknown,
    field: 'applicationId' | 'workspaceId' | 'groupId',
): string | undefined {
    return optionalString(value, field);
}

function optionalString(
    value: unknown,
    field: RecipeConsoleManagedPreferenceField,
): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') {
        throw new RecipeConsolePreferenceValidationError(
            field,
            `${fieldLabel(field)} must be text.`,
        );
    }
    const normalized = value.trim();
    if (!normalized) return undefined;
    if (normalized.length > MAX_CONTEXT_VALUE_LENGTH) {
        throw new RecipeConsolePreferenceValidationError(
            field,
            `${fieldLabel(field)} must be at most ${MAX_CONTEXT_VALUE_LENGTH} characters.`,
        );
    }
    return normalized;
}

function effectiveValue(
    bootstrapValue: string,
    personalValue: string | undefined,
    lock: 'url' | 'deployment' | undefined,
): string {
    return lock ? bootstrapValue : personalValue ?? bootstrapValue;
}

function defaultPreferences(): RecipeConsolePreferences {
    return {
        controlReadTimeoutMs: CONTROL_QUERY_DEFAULT_REQUEST_TIMEOUT_MS,
    };
}

function fieldLabel(field: RecipeConsoleManagedPreferenceField): string {
    switch (field) {
        case 'controlUrl': return 'Control URL';
        case 'apiBaseUrl': return 'API URL';
        case 'applicationId': return 'Application';
        case 'workspaceId': return 'Workspace';
        case 'groupId': return 'Group';
    }
}

function hasUnknownKeys(
    value: Record<string, unknown>,
    allowed: readonly string[],
): boolean {
    const allowedKeys = new Set(allowed);
    return Object.keys(value).some(key => !allowedKeys.has(key));
}

function removeUndefined(
    value: RecipeConsolePreferences,
): RecipeConsolePreferences {
    return Object.fromEntries(
        Object.entries(value).filter(([, entry]) => entry !== undefined),
    ) as RecipeConsolePreferences;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
