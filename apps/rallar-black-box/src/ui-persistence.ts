import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';
import type { AppModeId, AppTabId } from './app-tabs.ts';
import { appModeFromValue, appTabFromValue } from './app-tabs.ts';
import type { ManualDeliveryMode, ManualWorkbenchTransport, ManualWorkbenchValues } from './manual-workbench.ts';
import type { RallarServerRestCollection, RallarServerRestCollectionVariables } from './rallar-server-workbench.ts';
import type {
    RallarServerResponseBodyMode,
    RallarServerRestMethod
} from './rallar-server-workbench/rallar-server-workbench-contracts.ts';

export type RallarBlackBoxUiStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const UI_STORAGE_KEYS = {
    activeMode: 'rallar-black-box.ui.active-mode',
    activeTab: 'rallar-black-box.ui.active-tab',
    selectedCommandId: 'rallar-black-box.ui.selected-command-id',
    manualDraft: 'rallar-black-box.ui.manual-draft.v1',
    rallarServerDraft: 'rallar-black-box.ui.rallar-server-draft.v1',
    rallarServerCollectionDraft: 'rallar-black-box.ui.rallar-server-collection-draft.v1',
    eventFilters: 'rallar-black-box.ui.event-filters.v1'
} as const;

export type PersistedEventFilters = Readonly<{
    kind: string;
    commandId: string;
    connection: string;
    actor: string;
    transport: string;
    group: string;
    peer: string;
    selector: string;
    topic: string;
    severity: string;
}>;

export type ManualWorkbenchDraft = Readonly<{
    values: ManualWorkbenchValues;
    payloadPresetId: string;
    payloadText: string;
}>;

export type RallarServerWorkbenchDraft = Readonly<{
    apiBaseUrl: string;
    selectedPresetId: string;
    method: RallarServerRestMethod;
    path: string;
    headersText: string;
    queryText: string;
    bodyText: string;
    responseBodyMode: RallarServerResponseBodyMode;
    attachAuth: boolean;
    timeoutMs: number;
}>;

export type RallarServerRestCollectionDraft = Readonly<{
    selectedCollectionId: string;
    collection: RallarServerRestCollection;
    variables: RallarServerRestCollectionVariables;
}>;

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function readJson(storage: RallarBlackBoxUiStorage | undefined, key: string): unknown {
    if (!storage) {
        return undefined;
    }

    try {
        const value = storage.getItem(key);
        return value ? JSON.parse(value) as unknown : undefined;
    }
    catch {
        return undefined;
    }
}

function writeJson(storage: RallarBlackBoxUiStorage | undefined, key: string, value: unknown): void {
    if (!storage) {
        return;
    }

    try {
        storage.setItem(key, JSON.stringify(value));
    }
    catch {
        // Storage quota, privacy mode, and disabled storage should not break the workbench UI.
    }
}

function writeString(storage: RallarBlackBoxUiStorage | undefined, key: string, value: string): void {
    if (!storage) {
        return;
    }

    try {
        storage.setItem(key, value);
    }
    catch {
        // Ignore storage failures for the same reason as writeJson.
    }
}

function readString(storage: RallarBlackBoxUiStorage | undefined, key: string): string | undefined {
    if (!storage) {
        return undefined;
    }

    try {
        return storage.getItem(key) ?? undefined;
    }
    catch {
        return undefined;
    }
}

function stringValue(value: unknown, fallback: string): string {
    return typeof value === 'string' ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
    return typeof value === 'string' && allowed.includes(value as T)
        ? value as T
        : fallback;
}

function sanitizeJsonEditorText(text: string, secretValues: readonly string[] = []): string {
    const trimmed = text.trim();
    if (!trimmed) {
        return '';
    }

    try {
        const value = JSON.parse(trimmed) as unknown;
        return JSON.stringify(redactRallarBlackBoxValue(value, { secretValues }), null, 2);
    }
    catch {
        return '';
    }
}

export function readStoredAppTab(storage: RallarBlackBoxUiStorage | undefined): AppTabId | undefined {
    const value = readString(storage, UI_STORAGE_KEYS.activeTab);
    return value ? appTabFromValue(value) : undefined;
}

export function writeStoredAppTab(storage: RallarBlackBoxUiStorage | undefined, tab: AppTabId): void {
    writeString(storage, UI_STORAGE_KEYS.activeTab, tab);
}

export function readStoredAppMode(storage: RallarBlackBoxUiStorage | undefined): AppModeId | undefined {
    const value = readString(storage, UI_STORAGE_KEYS.activeMode);
    return value ? appModeFromValue(value) : undefined;
}

export function writeStoredAppMode(storage: RallarBlackBoxUiStorage | undefined, mode: AppModeId): void {
    writeString(storage, UI_STORAGE_KEYS.activeMode, mode);
}

export function readStoredSelectedCommandId(
    storage: RallarBlackBoxUiStorage | undefined
): string | undefined {
    return readString(storage, UI_STORAGE_KEYS.selectedCommandId);
}

export function writeStoredSelectedCommandId(
    storage: RallarBlackBoxUiStorage | undefined,
    commandId: string | undefined
): void {
    if (!storage) {
        return;
    }

    try {
        if (commandId) {
            storage.setItem(UI_STORAGE_KEYS.selectedCommandId, commandId);
        }
        else {
            storage.removeItem(UI_STORAGE_KEYS.selectedCommandId);
        }
    }
    catch {
        // Non-critical UI persistence.
    }
}

export function sanitizeManualWorkbenchDraft(
    draft: ManualWorkbenchDraft,
    secretValues: readonly string[] = []
): ManualWorkbenchDraft {
    const { rallarPassword: _rallarPassword, ...valuesWithoutPassword } = draft.values;
    return {
        values: {
            ...valuesWithoutPassword,
            rallarPassword: undefined
        },
        payloadPresetId: draft.payloadPresetId,
        payloadText: sanitizeJsonEditorText(draft.payloadText, secretValues)
    };
}

export function readManualWorkbenchDraft(
    storage: RallarBlackBoxUiStorage | undefined,
    defaults: ManualWorkbenchDraft
): ManualWorkbenchDraft | undefined {
    const record = asRecord(readJson(storage, UI_STORAGE_KEYS.manualDraft));
    if (Object.keys(record).length === 0) {
        return undefined;
    }

    const values = asRecord(record.values);
    return {
        values: {
            ...defaults.values,
            environment: stringValue(values.environment, defaults.values.environment),
            apiBaseUrl: stringValue(values.apiBaseUrl, defaults.values.apiBaseUrl),
            applicationId: stringValue(values.applicationId, defaults.values.applicationId),
            workspaceId: stringValue(values.workspaceId, defaults.values.workspaceId),
            actor: stringValue(values.actor, defaults.values.actor),
            sessionId: stringValue(values.sessionId, defaults.values.sessionId),
            groupId: stringValue(values.groupId, defaults.values.groupId),
            scopeText: stringValue(values.scopeText, defaults.values.scopeText),
            roomRefText: stringValue(values.roomRefText, defaults.values.roomRefText),
            minSnapshotVersion: numberValue(
                values.minSnapshotVersion,
                defaults.values.minSnapshotVersion
            ),
            connection: stringValue(values.connection, defaults.values.connection),
            targetClient: stringValue(values.targetClient, defaults.values.targetClient),
            multicastClients: stringValue(values.multicastClients, defaults.values.multicastClients),
            transport: oneOf<ManualWorkbenchTransport>(
                values.transport,
                ['realtime', 'messages.rtc', 'ws'],
                defaults.values.transport
            ),
            deliveryMode: oneOf<ManualDeliveryMode>(
                values.deliveryMode,
                ['direct', 'multicast', 'broadcast'],
                defaults.values.deliveryMode
            ),
            wsUrl: stringValue(values.wsUrl, defaults.values.wsUrl),
            topic: stringValue(values.topic, defaults.values.topic),
            typeId: stringValue(values.typeId, defaults.values.typeId),
            topicId: stringValue(values.topicId, defaults.values.topicId),
            timeoutMs: numberValue(values.timeoutMs, defaults.values.timeoutMs),
            providerMode: defaults.values.providerMode,
            rallarUsername: stringValue(values.rallarUsername, defaults.values.rallarUsername ?? ''),
            rallarPassword: defaults.values.rallarPassword,
            rallarRegister: booleanValue(values.rallarRegister, defaults.values.rallarRegister),
            rallarRestoreSession: booleanValue(
                values.rallarRestoreSession,
                defaults.values.rallarRestoreSession
            ),
            rallarLogoutOnClose: booleanValue(
                values.rallarLogoutOnClose,
                defaults.values.rallarLogoutOnClose
            ),
            rallarLeaveRoomOnClose: booleanValue(
                values.rallarLeaveRoomOnClose,
                defaults.values.rallarLeaveRoomOnClose
            )
        },
        payloadPresetId: stringValue(record.payloadPresetId, defaults.payloadPresetId),
        payloadText: stringValue(record.payloadText, defaults.payloadText)
    };
}

export function writeManualWorkbenchDraft(
    storage: RallarBlackBoxUiStorage | undefined,
    draft: ManualWorkbenchDraft,
    secretValues: readonly string[] = []
): void {
    writeJson(storage, UI_STORAGE_KEYS.manualDraft, sanitizeManualWorkbenchDraft(draft, secretValues));
}

export function sanitizeRallarServerWorkbenchDraft(
    draft: RallarServerWorkbenchDraft,
    secretValues: readonly string[] = []
): RallarServerWorkbenchDraft {
    return {
        ...draft,
        headersText: sanitizeJsonEditorText(draft.headersText, secretValues),
        queryText: sanitizeJsonEditorText(draft.queryText, secretValues),
        bodyText: sanitizeJsonEditorText(draft.bodyText, secretValues)
    };
}

export function readRallarServerWorkbenchDraft(
    storage: RallarBlackBoxUiStorage | undefined,
    defaults: RallarServerWorkbenchDraft
): RallarServerWorkbenchDraft | undefined {
    const record = asRecord(readJson(storage, UI_STORAGE_KEYS.rallarServerDraft));
    if (Object.keys(record).length === 0) {
        return undefined;
    }

    return {
        apiBaseUrl: stringValue(record.apiBaseUrl, defaults.apiBaseUrl),
        selectedPresetId: stringValue(record.selectedPresetId, defaults.selectedPresetId),
        method: oneOf<RallarServerRestMethod>(
            record.method,
            ['GET', 'POST', 'PUT', 'DELETE'],
            defaults.method
        ),
        path: stringValue(record.path, defaults.path),
        headersText: stringValue(record.headersText, defaults.headersText),
        queryText: stringValue(record.queryText, defaults.queryText),
        bodyText: stringValue(record.bodyText, defaults.bodyText),
        responseBodyMode: oneOf<RallarServerResponseBodyMode>(
            record.responseBodyMode,
            ['auto', 'json', 'text', 'none'],
            defaults.responseBodyMode
        ),
        attachAuth: booleanValue(record.attachAuth, defaults.attachAuth),
        timeoutMs: numberValue(record.timeoutMs, defaults.timeoutMs)
    };
}

export function writeRallarServerWorkbenchDraft(
    storage: RallarBlackBoxUiStorage | undefined,
    draft: RallarServerWorkbenchDraft,
    secretValues: readonly string[] = []
): void {
    writeJson(
        storage,
        UI_STORAGE_KEYS.rallarServerDraft,
        sanitizeRallarServerWorkbenchDraft(draft, secretValues)
    );
}

export function readRallarServerRestCollectionDraft(
    storage: RallarBlackBoxUiStorage | undefined,
    defaults: RallarServerRestCollectionDraft
): RallarServerRestCollectionDraft | undefined {
    const record = asRecord(readJson(storage, UI_STORAGE_KEYS.rallarServerCollectionDraft));
    if (Object.keys(record).length === 0) {
        return undefined;
    }

    const collection = asRecord(record.collection);
    const variables = asRecord(record.variables);
    return {
        selectedCollectionId: stringValue(record.selectedCollectionId, defaults.selectedCollectionId),
        collection: Object.keys(collection).length > 0
            ? collection as unknown as RallarServerRestCollection
            : defaults.collection,
        variables: Object.keys(variables).length > 0
            ? variables
            : defaults.variables
    };
}

export function writeRallarServerRestCollectionDraft(
    storage: RallarBlackBoxUiStorage | undefined,
    draft: RallarServerRestCollectionDraft,
    secretValues: readonly string[] = []
): void {
    writeJson(
        storage,
        UI_STORAGE_KEYS.rallarServerCollectionDraft,
        {
            selectedCollectionId: draft.selectedCollectionId,
            collection: redactRallarBlackBoxValue(draft.collection, { secretValues }),
            variables: redactRallarBlackBoxValue(draft.variables, { secretValues })
        }
    );
}

export function readEventFilters(
    storage: RallarBlackBoxUiStorage | undefined,
    defaults: PersistedEventFilters
): PersistedEventFilters {
    const record = asRecord(readJson(storage, UI_STORAGE_KEYS.eventFilters));
    return {
        kind: stringValue(record.kind, defaults.kind),
        commandId: stringValue(record.commandId, defaults.commandId),
        connection: stringValue(record.connection, defaults.connection),
        actor: stringValue(record.actor, defaults.actor),
        transport: stringValue(record.transport, defaults.transport),
        group: stringValue(record.group, defaults.group),
        peer: stringValue(record.peer, defaults.peer),
        selector: stringValue(record.selector, defaults.selector),
        topic: stringValue(record.topic, defaults.topic),
        severity: stringValue(record.severity, defaults.severity)
    };
}

export function writeEventFilters(
    storage: RallarBlackBoxUiStorage | undefined,
    filters: PersistedEventFilters
): void {
    writeJson(storage, UI_STORAGE_KEYS.eventFilters, filters);
}
