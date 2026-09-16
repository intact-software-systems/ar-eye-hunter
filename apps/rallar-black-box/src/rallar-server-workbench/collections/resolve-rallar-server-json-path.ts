import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

const PATH_TOKEN = /([^.[\]]+)|\[(\d+)\]/g;

export function resolveRallarServerJsonPath(value: unknown, path: string | undefined): unknown {
    if (!path || path === '$') {
        return value;
    }
    const normalized = path.startsWith('$.')
        ? path.slice(2)
        : path.startsWith('$')
        ? path.slice(1).replace(/^\./, '')
        : path;
    if (!normalized) {
        return value;
    }
    const tokens = [...normalized.matchAll(PATH_TOKEN)].map((match) => match[1] ?? match[2]).filter(Boolean);
    let current = value;
    for (const token of tokens) {
        if (Array.isArray(current)) {
            const index = Number(token);
            current = Number.isInteger(index) ? current[index] : undefined;
        }
        else if (isJsonRecordValue(current)) {
            current = current[token];
        }
        else {
            return undefined;
        }
    }
    return current;
}
