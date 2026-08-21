import type { RallarAiJsonRequest, RallarAiJsonResult, RallarAiJsonValue } from './rallar-ai-types.ts';

export function canonicalRallarAiJson(value: unknown): string {
    const issues = validateRallarAiJsonValue(value);
    if (issues.length > 0) {
        throw new Error(`Value is not JSON-compatible: ${issues[0]}`);
    }
    return serializeCanonicalJson(value as RallarAiJsonValue);
}

export function validateRallarAiJsonValue(
    value: unknown,
    path = '$'
): readonly string[] {
    const issues: string[] = [];
    collectJsonIssues(value, path, issues, new Set<object>());
    return issues;
}

export function hashRallarAiJson(value: unknown): string {
    return hashRallarAiCanonicalJson(canonicalRallarAiJson(value));
}

export function hashRallarAiCanonicalJson(canonicalJson: string): string {
    let hash = 0x811c9dc5;
    const bytes = new TextEncoder().encode(canonicalJson);

    for (const byte of bytes) {
        hash ^= byte;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }

    return `rallar-ai-fnv1a32:${hash.toString(16).padStart(8, '0')}`;
}

export function hashRallarAiSchema(schema: unknown): string {
    return hashRallarAiJson(schema);
}

export function hashRallarAiPrompt(input: {
    prompt: string;
    context?: unknown;
    schemaId?: string;
    schemaVersion?: string;
}): string {
    return hashRallarAiJson({
        prompt: input.prompt,
        context: input.context ?? null,
        schemaId: input.schemaId ?? null,
        schemaVersion: input.schemaVersion ?? null
    });
}

export function hashRallarAiRequest(
    request: RallarAiJsonRequest
): string {
    return hashRallarAiJson({
        requestId: request.requestId ?? null,
        schemaId: request.schemaId,
        schemaVersion: request.schemaVersion,
        schemaHash: hashRallarAiSchema(request.schema),
        promptHash: hashRallarAiPrompt(request),
        baseStateRevision: request.baseStateRevision ?? null,
        dedupeKey: request.dedupeKey ?? null
    });
}

export function hashRallarAiResult(
    result: RallarAiJsonResult
): string {
    return hashRallarAiJson({
        protocolVersion: result.protocolVersion,
        requestId: result.requestId ?? null,
        generationId: result.generationId,
        dedupeKey: result.dedupeKey ?? null,
        supersedesGenerationId: result.supersedesGenerationId ?? null,
        source: result.source,
        providerId: result.providerId,
        modelId: result.modelId ?? null,
        schemaId: result.schemaId,
        schemaVersion: result.schemaVersion,
        schemaHash: result.schemaHash,
        promptHash: result.promptHash,
        baseStateRevision: result.baseStateRevision ?? null,
        createdAtEpochMs: result.createdAtEpochMs,
        value: result.value,
        validation: result.validation,
        lifecycle: result.lifecycle ?? null
    });
}

function serializeCanonicalJson(value: RallarAiJsonValue): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        return `[${value.map(serializeCanonicalJson).join(',')}]`;
    }

    const entries = Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right));

    return `{${
        entries
            .map(
                ([key, entryValue]) => `${JSON.stringify(key)}:${serializeCanonicalJson(entryValue)}`
            )
            .join(',')
    }}`;
}

function collectJsonIssues(
    value: unknown,
    path: string,
    issues: string[],
    seenObjects: Set<object>
): void {
    if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'boolean'
    ) {
        return;
    }

    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            issues.push(`${path}: non-finite numbers are not JSON-compatible`);
        }
        return;
    }

    if (typeof value !== 'object') {
        issues.push(`${path}: ${typeof value} is not JSON-compatible`);
        return;
    }

    if (seenObjects.has(value)) {
        issues.push(`${path}: cyclic values are not JSON-compatible`);
        return;
    }
    seenObjects.add(value);

    if (Array.isArray(value)) {
        value.forEach((entry, index) => collectJsonIssues(entry, `${path}[${index}]`, issues, seenObjects));
        seenObjects.delete(value);
        return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        issues.push(`${path}: only plain objects are JSON-compatible`);
        seenObjects.delete(value);
        return;
    }

    for (const [key, entry] of Object.entries(value)) {
        if (entry === undefined) {
            issues.push(`${path}.${key}: undefined is not JSON-compatible`);
            continue;
        }
        collectJsonIssues(entry, `${path}.${key}`, issues, seenObjects);
    }

    seenObjects.delete(value);
}
