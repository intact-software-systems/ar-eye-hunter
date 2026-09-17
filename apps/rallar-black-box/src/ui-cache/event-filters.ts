import {
    decodeStoredText,
    isStoredJsonObject
} from './decode-cached-values.ts';
import type { RallarBlackBoxUiStorage } from './rallar-black-box-ui-storage.ts';
import {
    readStoredJson,
    UI_STORAGE_KEYS,
    writeStoredJson
} from './rallar-black-box-ui-storage.ts';

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

/** The cached filters, or `undefined` when the browser holds no entry the panel can read. */
export function readStoredEventFilters(
    storage: RallarBlackBoxUiStorage | undefined
): PersistedEventFilters | undefined {
    const record = readStoredJson(storage, UI_STORAGE_KEYS.eventFilters);
    if (!isStoredJsonObject(record)) {
        return undefined;
    }

    const kind = decodeStoredText(record.kind);
    const commandId = decodeStoredText(record.commandId);
    const connection = decodeStoredText(record.connection);
    const actor = decodeStoredText(record.actor);
    const transport = decodeStoredText(record.transport);
    const group = decodeStoredText(record.group);
    const peer = decodeStoredText(record.peer);
    const selector = decodeStoredText(record.selector);
    const topic = decodeStoredText(record.topic);
    const severity = decodeStoredText(record.severity);
    if (
        kind === undefined || commandId === undefined || connection === undefined ||
        actor === undefined || transport === undefined || group === undefined ||
        peer === undefined || selector === undefined || topic === undefined || severity === undefined
    ) {
        return undefined;
    }

    return { kind, commandId, connection, actor, transport, group, peer, selector, topic, severity };
}

export function writeStoredEventFilters(
    storage: RallarBlackBoxUiStorage | undefined,
    filters: PersistedEventFilters
): void {
    writeStoredJson(storage, UI_STORAGE_KEYS.eventFilters, filters);
}
