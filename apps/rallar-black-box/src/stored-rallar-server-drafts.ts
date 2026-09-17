import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';
import {
    decodeStoredBoolean,
    decodeStoredMember,
    decodeStoredNumber,
    decodeStoredText,
    isStoredJsonObject
} from './decode-stored-json-values.ts';
import { decodeRallarServerRestCollection } from './rallar-server-workbench/decode-rallar-server-rest-collection.ts';
import type {
    RallarServerResponseBodyMode,
    RallarServerRestCollection,
    RallarServerRestCollectionVariables,
    RallarServerRestMethod
} from './rallar-server-workbench/rallar-server-workbench-contracts.ts';
import { toRedactedJsonEditorText } from './to-redacted-json-editor-text.ts';
import type { RallarBlackBoxUiStorage } from './ui-persistence.ts';
import {
    readStoredJson,
    UI_STORAGE_KEYS,
    writeStoredJson
} from './ui-persistence.ts';

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

const RALLAR_SERVER_REST_METHODS: readonly RallarServerRestMethod[] = ['GET', 'POST', 'PUT', 'DELETE'];

const RALLAR_SERVER_RESPONSE_BODY_MODES: readonly RallarServerResponseBodyMode[] = [
    'auto',
    'json',
    'text',
    'none'
];

/**
 * The cached request draft, or `undefined` when the browser holds no entry the workbench can
 * read. A cached entry that does not decode is discarded whole, so the defaults apply instead.
 */
export function readStoredRallarServerWorkbenchDraft(
    storage: RallarBlackBoxUiStorage | undefined
): RallarServerWorkbenchDraft | undefined {
    const record = readStoredJson(storage, UI_STORAGE_KEYS.rallarServerDraft);
    if (!isStoredJsonObject(record)) {
        return undefined;
    }

    const apiBaseUrl = decodeStoredText(record.apiBaseUrl);
    const selectedPresetId = decodeStoredText(record.selectedPresetId);
    const method = decodeStoredMember(record.method, RALLAR_SERVER_REST_METHODS);
    const path = decodeStoredText(record.path);
    const headersText = decodeStoredText(record.headersText);
    const queryText = decodeStoredText(record.queryText);
    const bodyText = decodeStoredText(record.bodyText);
    const responseBodyMode = decodeStoredMember(record.responseBodyMode, RALLAR_SERVER_RESPONSE_BODY_MODES);
    const attachAuth = decodeStoredBoolean(record.attachAuth);
    const timeoutMs = decodeStoredNumber(record.timeoutMs);
    if (
        apiBaseUrl === undefined || selectedPresetId === undefined || method === undefined ||
        path === undefined || headersText === undefined || queryText === undefined ||
        bodyText === undefined || responseBodyMode === undefined || attachAuth === undefined ||
        timeoutMs === undefined
    ) {
        return undefined;
    }

    return {
        apiBaseUrl,
        selectedPresetId,
        method,
        path,
        headersText,
        queryText,
        bodyText,
        responseBodyMode,
        attachAuth,
        timeoutMs
    };
}

export function writeStoredRallarServerWorkbenchDraft(
    storage: RallarBlackBoxUiStorage | undefined,
    draft: RallarServerWorkbenchDraft,
    secretValues: readonly string[]
): void {
    writeStoredJson(
        storage,
        UI_STORAGE_KEYS.rallarServerDraft,
        toStoredRallarServerWorkbenchDraft(draft, secretValues)
    );
}

/** The request draft in the form the cache keeps: every JSON editor draft redacted. */
export function toStoredRallarServerWorkbenchDraft(
    draft: RallarServerWorkbenchDraft,
    secretValues: readonly string[]
): RallarServerWorkbenchDraft {
    return {
        ...draft,
        headersText: toRedactedJsonEditorText(draft.headersText, secretValues),
        queryText: toRedactedJsonEditorText(draft.queryText, secretValues),
        bodyText: toRedactedJsonEditorText(draft.bodyText, secretValues)
    };
}

/**
 * The cached collection draft, or `undefined` when the browser holds no entry whose collection
 * the workbench can read.
 */
export function readStoredRallarServerRestCollectionDraft(
    storage: RallarBlackBoxUiStorage | undefined
): RallarServerRestCollectionDraft | undefined {
    const record = readStoredJson(storage, UI_STORAGE_KEYS.rallarServerCollectionDraft);
    if (!isStoredJsonObject(record)) {
        return undefined;
    }

    const selectedCollectionId = decodeStoredText(record.selectedCollectionId);
    const collection = decodeRallarServerRestCollection(record.collection);
    if (
        selectedCollectionId === undefined || collection.right === undefined ||
        !isStoredJsonObject(record.variables)
    ) {
        return undefined;
    }

    return {
        selectedCollectionId,
        collection: collection.right,
        variables: record.variables
    };
}

export function writeStoredRallarServerRestCollectionDraft(
    storage: RallarBlackBoxUiStorage | undefined,
    draft: RallarServerRestCollectionDraft,
    secretValues: readonly string[]
): void {
    writeStoredJson(storage, UI_STORAGE_KEYS.rallarServerCollectionDraft, {
        selectedCollectionId: draft.selectedCollectionId,
        collection: redactRallarBlackBoxValue(draft.collection, { secretValues }),
        variables: redactRallarBlackBoxValue(draft.variables, { secretValues })
    });
}
