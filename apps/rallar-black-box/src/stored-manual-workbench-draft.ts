import type { ApiJsonObject } from '@shared/api/api-json-value.ts';
import type { RallarBlackBoxProviderMode } from './client-defaults.ts';
import {
    decodeStoredBoolean,
    decodeStoredMember,
    decodeStoredNumber,
    decodeStoredText,
    isStoredJsonObject
} from './decode-stored-json-values.ts';
import type { ManualDeliveryMode, ManualWorkbenchTransport, ManualWorkbenchValues } from './manual-workbench.ts';
import { toRedactedJsonEditorText } from './to-redacted-json-editor-text.ts';
import type { RallarBlackBoxUiStorage } from './ui-persistence.ts';
import {
    readStoredJson,
    UI_STORAGE_KEYS,
    writeStoredJson
} from './ui-persistence.ts';

export type ManualWorkbenchDraft = Readonly<{
    values: ManualWorkbenchValues;
    payloadPresetId: string;
    payloadText: string;
}>;

/** The manual workbench values the session owns; the browser cache neither writes nor restores them. */
export interface ManualWorkbenchSessionValues {
    readonly providerMode: RallarBlackBoxProviderMode;
    readonly rallarPassword: string | undefined;
}

const MANUAL_WORKBENCH_TRANSPORTS: readonly ManualWorkbenchTransport[] = ['realtime', 'messages.rtc', 'ws'];

const MANUAL_DELIVERY_MODES: readonly ManualDeliveryMode[] = ['direct', 'multicast', 'broadcast'];

/**
 * The cached draft, or `undefined` when the browser holds no entry the workbench can read. A
 * cached entry that does not decode is discarded whole, so the caller's defaults apply instead.
 */
export function readStoredManualWorkbenchDraft(
    storage: RallarBlackBoxUiStorage | undefined,
    sessionValues: ManualWorkbenchSessionValues
): ManualWorkbenchDraft | undefined {
    const record = readStoredJson(storage, UI_STORAGE_KEYS.manualDraft);
    if (!isStoredJsonObject(record)) {
        return undefined;
    }

    const values = isStoredJsonObject(record.values)
        ? decodeManualWorkbenchValues(record.values, sessionValues)
        : undefined;
    const payloadPresetId = decodeStoredText(record.payloadPresetId);
    const payloadText = decodeStoredText(record.payloadText);
    if (values === undefined || payloadPresetId === undefined || payloadText === undefined) {
        return undefined;
    }

    return { values, payloadPresetId, payloadText };
}

export function writeStoredManualWorkbenchDraft(
    storage: RallarBlackBoxUiStorage | undefined,
    draft: ManualWorkbenchDraft,
    secretValues: readonly string[]
): void {
    writeStoredJson(
        storage,
        UI_STORAGE_KEYS.manualDraft,
        toStoredManualWorkbenchDraft(draft, secretValues)
    );
}

/** The draft in the form the cache keeps: session-owned values left out, payload draft redacted. */
export function toStoredManualWorkbenchDraft(
    draft: ManualWorkbenchDraft,
    secretValues: readonly string[]
): ApiJsonObject {
    return {
        values: toStoredManualWorkbenchValues(draft.values),
        payloadPresetId: draft.payloadPresetId,
        payloadText: toRedactedJsonEditorText(draft.payloadText, secretValues)
    };
}

function toStoredManualWorkbenchValues(values: ManualWorkbenchValues): ApiJsonObject {
    return {
        environment: values.environment,
        apiBaseUrl: values.apiBaseUrl,
        applicationId: values.applicationId,
        workspaceId: values.workspaceId,
        actor: values.actor,
        sessionId: values.sessionId,
        groupId: values.groupId,
        scopeText: values.scopeText,
        roomRefText: values.roomRefText,
        minSnapshotVersion: values.minSnapshotVersion,
        connection: values.connection,
        targetClient: values.targetClient,
        multicastClients: values.multicastClients,
        transport: values.transport,
        deliveryMode: values.deliveryMode,
        wsUrl: values.wsUrl,
        topic: values.topic,
        typeId: values.typeId,
        topicId: values.topicId,
        timeoutMs: values.timeoutMs,
        ...(values.rallarUsername === undefined ? {} : { rallarUsername: values.rallarUsername }),
        rallarRegister: values.rallarRegister,
        rallarRestoreSession: values.rallarRestoreSession,
        rallarLogoutOnClose: values.rallarLogoutOnClose,
        rallarLeaveRoomOnClose: values.rallarLeaveRoomOnClose
    };
}

function decodeManualWorkbenchValues(
    record: ApiJsonObject,
    sessionValues: ManualWorkbenchSessionValues
): ManualWorkbenchValues | undefined {
    const scope = decodeManualScopeValues(record);
    const delivery = decodeManualDeliveryValues(record);
    const rallar = decodeManualRallarValues(record);
    if (scope === undefined || delivery === undefined || rallar === undefined) {
        return undefined;
    }

    return {
        ...scope,
        ...delivery,
        ...rallar,
        providerMode: sessionValues.providerMode,
        rallarPassword: sessionValues.rallarPassword
    };
}

type ManualScopeValues = Pick<
    ManualWorkbenchValues,
    | 'environment'
    | 'apiBaseUrl'
    | 'applicationId'
    | 'workspaceId'
    | 'actor'
    | 'sessionId'
    | 'groupId'
    | 'scopeText'
    | 'roomRefText'
    | 'minSnapshotVersion'
>;

function decodeManualScopeValues(record: ApiJsonObject): ManualScopeValues | undefined {
    const environment = decodeStoredText(record.environment);
    const apiBaseUrl = decodeStoredText(record.apiBaseUrl);
    const applicationId = decodeStoredText(record.applicationId);
    const workspaceId = decodeStoredText(record.workspaceId);
    const actor = decodeStoredText(record.actor);
    const sessionId = decodeStoredText(record.sessionId);
    const groupId = decodeStoredText(record.groupId);
    const scopeText = decodeStoredText(record.scopeText);
    const roomRefText = decodeStoredText(record.roomRefText);
    const minSnapshotVersion = decodeStoredNumber(record.minSnapshotVersion);
    if (
        environment === undefined || apiBaseUrl === undefined || applicationId === undefined ||
        workspaceId === undefined || actor === undefined || sessionId === undefined ||
        groupId === undefined || scopeText === undefined || roomRefText === undefined ||
        minSnapshotVersion === undefined
    ) {
        return undefined;
    }

    return {
        environment,
        apiBaseUrl,
        applicationId,
        workspaceId,
        actor,
        sessionId,
        groupId,
        scopeText,
        roomRefText,
        minSnapshotVersion
    };
}

type ManualDeliveryValues = Pick<
    ManualWorkbenchValues,
    | 'connection'
    | 'targetClient'
    | 'multicastClients'
    | 'transport'
    | 'deliveryMode'
    | 'wsUrl'
    | 'topic'
    | 'typeId'
    | 'topicId'
    | 'timeoutMs'
>;

function decodeManualDeliveryValues(record: ApiJsonObject): ManualDeliveryValues | undefined {
    const connection = decodeStoredText(record.connection);
    const targetClient = decodeStoredText(record.targetClient);
    const multicastClients = decodeStoredText(record.multicastClients);
    const transport = decodeStoredMember(record.transport, MANUAL_WORKBENCH_TRANSPORTS);
    const deliveryMode = decodeStoredMember(record.deliveryMode, MANUAL_DELIVERY_MODES);
    const wsUrl = decodeStoredText(record.wsUrl);
    const topic = decodeStoredText(record.topic);
    const typeId = decodeStoredText(record.typeId);
    const topicId = decodeStoredText(record.topicId);
    const timeoutMs = decodeStoredNumber(record.timeoutMs);
    if (
        connection === undefined || targetClient === undefined || multicastClients === undefined ||
        transport === undefined || deliveryMode === undefined || wsUrl === undefined ||
        topic === undefined || typeId === undefined || topicId === undefined || timeoutMs === undefined
    ) {
        return undefined;
    }

    return {
        connection,
        targetClient,
        multicastClients,
        transport,
        deliveryMode,
        wsUrl,
        topic,
        typeId,
        topicId,
        timeoutMs
    };
}

type ManualRallarValues = Pick<
    ManualWorkbenchValues,
    | 'rallarUsername'
    | 'rallarRegister'
    | 'rallarRestoreSession'
    | 'rallarLogoutOnClose'
    | 'rallarLeaveRoomOnClose'
>;

function decodeManualRallarValues(record: ApiJsonObject): ManualRallarValues | undefined {
    const rallarRegister = decodeStoredBoolean(record.rallarRegister);
    const rallarRestoreSession = decodeStoredBoolean(record.rallarRestoreSession);
    const rallarLogoutOnClose = decodeStoredBoolean(record.rallarLogoutOnClose);
    const rallarLeaveRoomOnClose = decodeStoredBoolean(record.rallarLeaveRoomOnClose);
    if (
        rallarRegister === undefined || rallarRestoreSession === undefined ||
        rallarLogoutOnClose === undefined || rallarLeaveRoomOnClose === undefined
    ) {
        return undefined;
    }

    return {
        rallarUsername: decodeStoredText(record.rallarUsername),
        rallarRegister,
        rallarRestoreSession,
        rallarLogoutOnClose,
        rallarLeaveRoomOnClose
    };
}
