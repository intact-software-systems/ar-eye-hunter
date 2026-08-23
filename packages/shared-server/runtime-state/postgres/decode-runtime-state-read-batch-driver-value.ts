import {
    decodeJsonWireValue,
    type JsonWireObject,
    type JsonWireValue
} from '../../rallar-system/protocol/json-wire-identity.ts';

export function decodeRuntimeStateReadBatchDriverValue(
    input: JsonWireValue
): JsonWireValue {
    const parsed = typeof input === 'string' ? parsePayload(input) : input;
    if (!Array.isArray(parsed)) {
        return parsed;
    }
    return parsed.map((selection) => {
        if (!isJsonWireObject(selection) || !Array.isArray(selection.entries)) {
            return selection;
        }
        return {
            ...selection,
            entries: selection.entries.map((entry) => {
                if (!isJsonWireObject(entry)) {
                    return entry;
                }
                return {
                    ...entry,
                    expireAtTimestamp: normalizeDriverInteger(entry.expireAtTimestamp),
                    revision: normalizeDriverInteger(entry.revision)
                };
            })
        };
    });
}

function parsePayload(input: string): JsonWireValue {
    try {
        return decodeJsonWireValue(
            JSON.parse(input),
            'runtime state read batch database JSON'
        );
    }
    catch (caught) {
        const error = caught instanceof Error ? caught : new Error(String(caught));
        throw new Error(
            `Invalid runtime state read batch database JSON: ${error.message}`,
            { cause: error }
        );
    }
}

function normalizeDriverInteger(input: JsonWireValue | undefined): JsonWireValue {
    if (typeof input !== 'string' || !/^-?(0|[1-9]\d*)$/u.test(input)) {
        return input ?? null;
    }
    const parsed = Number(input);
    return Number.isSafeInteger(parsed) ? parsed : input;
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
