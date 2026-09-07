import type { ApiJsonObject, ApiJsonValue } from '@shared/api/api-json-value.ts';

/**
 * Some frames carry a nested document as a JSON *string* — a group-state delta's
 * `payload.resource` holds the whole envelope that way. The comparator has no
 * decode step, so a wait can match the outer frame but never a field inside the
 * string: a recipe can `jsonParse` a frame it has already matched, but it cannot
 * select which frame to wait for.
 *
 * Declaring `expect.decodeJsonPaths` decodes those paths in the observed frame
 * before comparison, so the expectation is written against the decoded shape.
 */
export function toDecodedJsonStringPaths(
    message: ApiJsonValue,
    paths: readonly string[]
): ApiJsonValue {
    if (paths.length <= 0) {
        return message;
    }

    return paths.reduce<ApiJsonValue>(
        (decoded, path) => toDecodedPath(decoded, path.split('.')),
        message
    );
}

/**
 * A path that is absent, or whose value is not a parseable JSON string, is left
 * exactly as it was: a frame that does not carry the nested document should fail
 * the expectation on its own terms, not disappear from the candidate set.
 */
function toDecodedPath(value: ApiJsonValue, segments: readonly string[]): ApiJsonValue {
    if (!isJsonObject(value)) {
        return value;
    }

    const [head, ...rest] = segments;
    const current = value[head];
    if (current === undefined) {
        return value;
    }

    if (rest.length > 0) {
        return { ...value, [head]: toDecodedPath(current, rest) };
    }

    const decoded = toParsedJson(current);
    return decoded === undefined ? value : { ...value, [head]: decoded };
}

function toParsedJson(value: ApiJsonValue): ApiJsonValue | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }

    try {
        return JSON.parse(value) as ApiJsonValue;
    }
    catch {
        return undefined;
    }
}

function isJsonObject(value: ApiJsonValue): value is ApiJsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
