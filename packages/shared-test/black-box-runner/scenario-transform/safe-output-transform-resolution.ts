export interface SafeOutputTransformEvaluationInput {
    readonly resolverRoot: Record<string, unknown>;
    readonly result?: unknown;
    readonly operatorPath?: string;
    readonly createUuid: () => string;
    readonly readTimestamp: () => number;
}

export interface SafeOutputTransformDetails {
    readonly operator: string;
    readonly path: unknown;
    readonly [key: string]: unknown;
}

type PathResolution = Readonly<{ found: false; }> | Readonly<{ found: true; value: unknown; }>;

export class SafeOutputTransformError extends Error {
    readonly details: SafeOutputTransformDetails;

    constructor(message: string, details: SafeOutputTransformDetails) {
        super(message);
        this.name = 'SafeOutputTransformError';
        this.details = details;
    }
}

export function resolveSafeOutputTransformPath(
    path: unknown,
    input: SafeOutputTransformEvaluationInput
): unknown {
    if (typeof path !== 'string' || path.trim().length <= 0) {
        return rejectSafeOutputTransform('Transform path must be a non-empty string.', {
            operator: 'path',
            path
        });
    }

    const actual = readProperty(input.result, 'actual');
    const resultRoots = [input.result, actual, readProperty(actual, 'body')];
    for (const root of [...resultRoots, toTransformResolverRoot(input)]) {
        const resolved = tryResolvePath(path, root);
        if (resolved.found) {
            return resolved.value;
        }
    }

    return rejectSafeOutputTransform(`Cannot resolve transform path {${path}}`, {
        operator: 'path',
        path
    });
}

export function resolveSafeOutputTransformTemplate(
    value: string,
    input: SafeOutputTransformEvaluationInput
): unknown {
    const root = toTransformResolverRoot(input);
    const exactMatch = value.match(/^\{([A-Za-z_$][\w$-]*(?:\.[\w$-]+)*)\}$/u);
    if (exactMatch) {
        return resolvePath(exactMatch[1], root);
    }

    return value.replaceAll(
        /\{([A-Za-z_$][\w$-]*(?:\.[\w$-]+)*)\}/gu,
        (_match, path) => stringifySafeOutputTransformValue(resolvePath(path, root))
    );
}

export function stringifySafeOutputTransformValue(value: unknown): string {
    if (value === undefined || value === null) {
        return String(value);
    }
    return typeof value === 'string' ? value : JSON.stringify(value);
}

export function rejectSafeOutputTransform(
    message: string,
    details: SafeOutputTransformDetails
): never {
    throw new SafeOutputTransformError(message, details);
}

export function isSafeOutputTransformRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toTransformResolverRoot(input: SafeOutputTransformEvaluationInput): unknown {
    const actual = readProperty(input.result, 'actual');
    return {
        ...input.resolverRoot,
        result: input.result,
        actual,
        body: readProperty(actual, 'body')
    };
}

function resolvePath(path: string, root: unknown): unknown {
    const resolved = tryResolvePath(path, root);
    if (!resolved.found) {
        throw new Error(`Cannot resolve placeholder {${path}}`);
    }
    return resolved.value;
}

function tryResolvePath(path: string, root: unknown): PathResolution {
    const segments = path
        .replaceAll(/\[(\d+)]/g, '.$1')
        .split('.')
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0);
    return readPathSegments(segments, root);
}

function readPathSegments(segments: readonly string[], value: unknown): PathResolution {
    if (segments.length === 0) {
        return value === undefined ? { found: false } : { found: true, value };
    }
    const [segment, ...remaining] = segments;
    if (segment !== '*') {
        return readPathSegments(remaining, readProperty(value, segment));
    }
    if (!Array.isArray(value)) {
        return { found: false };
    }
    const projected: unknown[] = [];
    for (const member of value) {
        const resolved = readPathSegments(remaining, member);
        if (!resolved.found) {
            return { found: false };
        }
        projected.push(resolved.value);
    }
    return { found: true, value: projected };
}

function readProperty(value: unknown, key: string): unknown {
    if (value === undefined || value === null) {
        return undefined;
    }
    return Reflect.get(Object(value), key);
}
