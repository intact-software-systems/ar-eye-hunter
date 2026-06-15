import { AppTopics } from './api-config.ts';
import type { GroupRef } from './group-types.ts';

export const RALLAR_ROUTE_ID_MAX_LENGTH = 128;
export const RALLAR_DEFAULT_MAX_MESSAGE_PAYLOAD_BYTES = 64 * 1024;
export const RALLAR_USER_WS_TOPIC_PREFIXES = ['app.', 'room.'] as const;
export const RALLAR_RESERVED_WS_TOPIC_PREFIXES = ['rallar.'] as const;
export const RALLAR_AL_CONTROL_TOPIC_ID = 'al-control';

const RALLAR_ROUTE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const RESERVED_ROUTE_IDS = new Set(['.', '..']);
const RESERVED_WS_TOPIC_IDS = new Set<string>([
    ...Object.values(AppTopics),
    RALLAR_AL_CONTROL_TOPIC_ID,
]);

export type RallarValidationIssue = Readonly<{
    path: string;
    code: string;
    message: string;
}>;

export type RallarValidationResult = Readonly<{
    ok: boolean;
    errors: readonly string[];
    issues: readonly RallarValidationIssue[];
}>;

export type RallarJsonPayloadValidationResult = RallarValidationResult & Readonly<{
    serialized?: string;
    byteLength?: number;
}>;

export type RallarBrandedString<TBrand extends string> =
    string & { readonly __rallarBrand: TBrand };

export type RallarRouteId = RallarBrandedString<'routeId'>;
export type RallarRoomId = RallarBrandedString<'roomId'>;
export type RallarTopicId = RallarBrandedString<'topicId'>;
export type RallarTypeId = RallarBrandedString<'typeId'>;
export type RallarWsUserTopicId = RallarBrandedString<'wsUserTopicId'>;

export class RallarValidationError extends Error {
    readonly issues: readonly RallarValidationIssue[];

    constructor(
        message: string,
        issues: readonly RallarValidationIssue[],
    ) {
        super(message);
        this.name = 'RallarValidationError';
        this.issues = [...issues];
    }
}

export function okRallarValidation(): RallarValidationResult {
    return {
        ok: true,
        errors: [],
        issues: [],
    };
}

export function failRallarValidation(
    issues: readonly RallarValidationIssue[],
): RallarValidationResult {
    return {
        ok: issues.length === 0,
        errors: issues.map((issue) => `${issue.path}: ${issue.message}`),
        issues,
    };
}

export function formatRallarValidation(
    result: RallarValidationResult | readonly RallarValidationIssue[],
): string {
    const issues: readonly RallarValidationIssue[] = Array.isArray(result)
        ? result
        : (result as RallarValidationResult).issues;
    if (issues.length === 0) {
        return 'Rallar input is valid.';
    }

    return issues
        .map((issue: RallarValidationIssue) => `${issue.path}: ${issue.message}`)
        .join('\n');
}

export function isRallarValidationError(
    error: unknown,
): error is RallarValidationError {
    return error instanceof RallarValidationError ||
        (
            typeof error === 'object' &&
            error !== null &&
            (error as { name?: unknown }).name === 'RallarValidationError' &&
            Array.isArray((error as { issues?: unknown }).issues)
        );
}

export function throwRallarValidation(
    issues: readonly RallarValidationIssue[],
): never {
    throw new RallarValidationError(formatRallarValidation(issues), issues);
}

export function assertValidRallarRouteId(
    value: unknown,
    path = '$',
    label = 'Route ID',
): RallarRouteId {
    const result = validateRallarRouteId(value, path, label);
    if (!result.ok) {
        throwRallarValidation(result.issues);
    }

    return value as RallarRouteId;
}

export function validateRallarRouteId(
    value: unknown,
    path = '$',
    label = 'Route ID',
): RallarValidationResult {
    const issues: RallarValidationIssue[] = [];
    pushRouteIdIssues(value, path, label, issues);
    return issues.length === 0 ? okRallarValidation() : failRallarValidation(issues);
}

export function toRallarRoomId(value: unknown): RallarRoomId {
    return assertValidRallarRouteId(value, '$', 'Room ID') as unknown as RallarRoomId;
}

export function toRallarTopicId(value: unknown): RallarTopicId {
    return assertValidRallarRouteId(value, '$', 'Topic ID') as unknown as RallarTopicId;
}

export function toRallarTypeId(value: unknown): RallarTypeId {
    return assertValidRallarRouteId(value, '$', 'Type ID') as unknown as RallarTypeId;
}

export function toRallarWsUserTopicId(value: unknown): RallarWsUserTopicId {
    assertValidRallarWsUserTopicId(value, '$');
    return value as RallarWsUserTopicId;
}

export function assertValidRallarWsUserTopicId(
    value: unknown,
    path = '$',
): RallarWsUserTopicId {
    const result = validateRallarWsUserTopicId(value, path);
    if (!result.ok) {
        throwRallarValidation(result.issues);
    }

    return value as RallarWsUserTopicId;
}

export function validateRallarWsUserTopicId(
    value: unknown,
    path = '$',
): RallarValidationResult {
    const routeId = validateRallarRouteId(value, path, 'WS user topic ID');
    if (!routeId.ok) {
        return routeId;
    }

    const topicId = value as string;
    if (isReservedRallarWsTopicId(topicId)) {
        return failRallarValidation([
            {
                path,
                code: 'reserved-ws-topic',
                message: `Rallar WS topic is reserved: ${topicId}.`,
            },
        ]);
    }

    if (!RALLAR_USER_WS_TOPIC_PREFIXES.some((prefix) => topicId.startsWith(prefix))) {
        return failRallarValidation([
            {
                path,
                code: 'invalid-ws-user-topic',
                message:
                    `Rallar user WS topic must start with ${RALLAR_USER_WS_TOPIC_PREFIXES.join(' or ')}.`,
            },
        ]);
    }

    return okRallarValidation();
}

export function isReservedRallarWsTopicId(topicId: string): boolean {
    return RESERVED_WS_TOPIC_IDS.has(topicId) ||
        RALLAR_RESERVED_WS_TOPIC_PREFIXES.some((prefix) => topicId.startsWith(prefix));
}

export function validateRallarGroupRef(
    value: unknown,
    path = '$',
): RallarValidationResult {
    const issues: RallarValidationIssue[] = [];
    if (!isRecord(value)) {
        return failRallarValidation([
            {
                path,
                code: 'invalid-group-ref',
                message: 'Group ref must be an object.',
            },
        ]);
    }

    pushRouteIdIssues(
        value.applicationId,
        `${path}.applicationId`,
        'Application ID',
        issues,
    );
    if (value.workspaceId !== undefined) {
        pushRouteIdIssues(
            value.workspaceId,
            `${path}.workspaceId`,
            'Workspace ID',
            issues,
        );
    }
    pushRouteIdIssues(value.groupId, `${path}.groupId`, 'Group ID', issues);

    return issues.length === 0 ? okRallarValidation() : failRallarValidation(issues);
}

export function assertValidRallarGroupRef(
    value: unknown,
    path = '$',
): GroupRef {
    const result = validateRallarGroupRef(value, path);
    if (!result.ok) {
        throwRallarValidation(result.issues);
    }

    return value as GroupRef;
}

export function validateRallarJsonPayload(
    value: unknown,
    options: Readonly<{
        path?: string;
        maxBytes?: number;
    }> = {},
): RallarJsonPayloadValidationResult {
    const path = options.path ?? '$';
    const maxBytes = options.maxBytes ?? RALLAR_DEFAULT_MAX_MESSAGE_PAYLOAD_BYTES;
    const issues: RallarValidationIssue[] = [];
    validateJsonCompatibleValue(value, path, issues, new WeakSet<object>());
    if (issues.length > 0) {
        return {
            ...failRallarValidation(issues),
            serialized: undefined,
            byteLength: undefined,
        };
    }

    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
        return {
            ...failRallarValidation([
                {
                    path,
                    code: 'invalid-json-payload',
                    message: 'Payload must serialize to JSON.',
                },
            ]),
            serialized: undefined,
            byteLength: undefined,
        };
    }

    const byteLength = new TextEncoder().encode(serialized).length;
    if (byteLength > maxBytes) {
        return {
            ...failRallarValidation([
                {
                    path,
                    code: 'payload-too-large',
                    message: `Payload exceeds ${maxBytes} bytes.`,
                },
            ]),
            serialized,
            byteLength,
        };
    }

    return {
        ...okRallarValidation(),
        serialized,
        byteLength,
    };
}

export function assertValidRallarJsonPayload(
    value: unknown,
    options: Readonly<{
        path?: string;
        maxBytes?: number;
    }> = {},
): Readonly<{ serialized: string; byteLength: number }> {
    const result = validateRallarJsonPayload(value, options);
    if (!result.ok) {
        throwRallarValidation(result.issues);
    }

    return {
        serialized: result.serialized ?? JSON.stringify(value),
        byteLength: result.byteLength ?? 0,
    };
}

export function validateRallarNonNegativeInteger(
    value: unknown,
    path = '$',
): RallarValidationResult {
    if (
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value >= 0
    ) {
        return okRallarValidation();
    }

    return failRallarValidation([
        {
            path,
            code: 'invalid-non-negative-integer',
            message: 'Expected a finite non-negative integer.',
        },
    ]);
}

export function assertValidRallarNonNegativeInteger(
    value: unknown,
    path = '$',
): number {
    const result = validateRallarNonNegativeInteger(value, path);
    if (!result.ok) {
        throwRallarValidation(result.issues);
    }

    return value as number;
}

function pushRouteIdIssues(
    value: unknown,
    path: string,
    label: string,
    issues: RallarValidationIssue[],
): void {
    if (typeof value !== 'string') {
        issues.push({
            path,
            code: 'invalid-type',
            message: `${label} must be a string.`,
        });
        return;
    }

    if (value.length === 0) {
        issues.push({
            path,
            code: 'required',
            message: `${label} is required.`,
        });
        return;
    }

    if (value.trim() !== value) {
        issues.push({
            path,
            code: 'not-trimmed',
            message: `${label} must not include leading or trailing whitespace.`,
        });
        return;
    }

    if (value.length > RALLAR_ROUTE_ID_MAX_LENGTH) {
        issues.push({
            path,
            code: 'max-length',
            message: `${label} must be at most ${RALLAR_ROUTE_ID_MAX_LENGTH} characters.`,
        });
        return;
    }

    if (RESERVED_ROUTE_IDS.has(value)) {
        issues.push({
            path,
            code: 'reserved-route-id',
            message: `${label} is reserved.`,
        });
        return;
    }

    if (!RALLAR_ROUTE_ID_PATTERN.test(value)) {
        issues.push({
            path,
            code: 'invalid-route-id',
            message:
                `${label} may only contain letters, numbers, dot, underscore, colon, and hyphen.`,
        });
    }
}

function validateJsonCompatibleValue(
    value: unknown,
    path: string,
    issues: RallarValidationIssue[],
    seen: WeakSet<object>,
): void {
    if (value === null) {
        return;
    }

    switch (typeof value) {
        case 'string':
        case 'boolean':
            return;
        case 'number':
            if (!Number.isFinite(value)) {
                issues.push({
                    path,
                    code: 'invalid-json-number',
                    message: 'JSON payload numbers must be finite.',
                });
            }
            return;
        case 'undefined':
        case 'function':
        case 'symbol':
        case 'bigint':
            issues.push({
                path,
                code: 'invalid-json-payload',
                message: 'Payload must be JSON-compatible.',
            });
            return;
        case 'object':
            break;
    }

    if (seen.has(value)) {
        issues.push({
            path,
            code: 'invalid-json-payload',
            message: 'Payload must not contain cyclic references.',
        });
        return;
    }

    seen.add(value);
    if (Array.isArray(value)) {
        value.forEach((entry, index) =>
            validateJsonCompatibleValue(entry, `${path}[${index}]`, issues, seen)
        );
    } else {
        for (const [key, entry] of Object.entries(value)) {
            validateJsonCompatibleValue(entry, `${path}.${key}`, issues, seen);
        }
    }
    seen.delete(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
