import {
    GROUP_DIRECTORY_DEFAULT_LIMIT,
    GROUP_DIRECTORY_MAX_LIMIT
} from '@shared/api/group-directory/group-directory-types.ts';
import type { Group } from '@shared/api/group-types.ts';
import { Either } from '@shared/resilience/Either.ts';

export interface GroupDirectoryCursor {
    readonly onlineMemberCount: number;
    readonly groupId: string;
}

export interface GroupDirectoryQuery {
    readonly kind: Group['kind'] | null;
    readonly q: string | null;
    readonly limit: number;
    readonly after: GroupDirectoryCursor | null;
    readonly includeEmpty: boolean;
}

const GROUP_KINDS: readonly Group['kind'][] = ['party', 'room', 'team', 'custom'];

export function encodeGroupDirectoryCursor(cursor: GroupDirectoryCursor): string {
    return btoa(JSON.stringify([cursor.onlineMemberCount, cursor.groupId]))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
}

export function decodeGroupDirectoryQuery(
    searchParams: URLSearchParams
): Either<readonly string[], GroupDirectoryQuery> {
    const issues: string[] = [];
    const kind = readKind(searchParams, issues);
    const limit = readLimit(searchParams, issues);
    const after = readCursor(searchParams, issues);
    const includeEmpty = readIncludeEmpty(searchParams, issues);
    const q = searchParams.get('q')?.trim().toLowerCase() || null;

    return issues.length > 0
        ? Either.ofLeft(issues)
        : Either.ofRight({ kind, q, limit, after, includeEmpty });
}

function readKind(searchParams: URLSearchParams, issues: string[]): Group['kind'] | null {
    const value = searchParams.get('kind');
    if (value === null) {
        return null;
    }
    const kind = GROUP_KINDS.find((candidate) => candidate === value);
    if (!kind) {
        issues.push(`kind must be one of ${GROUP_KINDS.join(', ')}`);
        return null;
    }
    return kind;
}

function readLimit(searchParams: URLSearchParams, issues: string[]): number {
    const value = searchParams.get('limit');
    if (value === null) {
        return GROUP_DIRECTORY_DEFAULT_LIMIT;
    }
    const limit = /^[1-9][0-9]*$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(limit) || limit > GROUP_DIRECTORY_MAX_LIMIT) {
        issues.push(`limit must be an integer from 1 to ${GROUP_DIRECTORY_MAX_LIMIT}`);
        return GROUP_DIRECTORY_DEFAULT_LIMIT;
    }
    return limit;
}

function readIncludeEmpty(searchParams: URLSearchParams, issues: string[]): boolean {
    const value = searchParams.get('includeEmpty');
    if (value === null || value === 'false') {
        return false;
    }
    if (value !== 'true') {
        issues.push('includeEmpty must be true or false');
    }
    return value === 'true';
}

function readCursor(searchParams: URLSearchParams, issues: string[]): GroupDirectoryCursor | null {
    const value = searchParams.get('cursor');
    if (value === null) {
        return null;
    }
    const cursor = parseCursor(value);
    if (!cursor) {
        issues.push('cursor is not a cursor issued by this endpoint');
    }
    return cursor;
}

function parseCursor(value: string): GroupDirectoryCursor | null {
    try {
        const padded = value.replaceAll('-', '+').replaceAll('_', '/');
        return decodeCursorTuple(JSON.parse(atob(padded + '='.repeat((4 - padded.length % 4) % 4))));
    }
    catch {
        return null;
    }
}

function decodeCursorTuple(value: unknown): GroupDirectoryCursor | null {
    if (
        Array.isArray(value) && value.length === 2 &&
        typeof value[0] === 'number' && Number.isSafeInteger(value[0]) && value[0] >= 0 &&
        typeof value[1] === 'string' && value[1].length > 0
    ) {
        return { onlineMemberCount: value[0], groupId: value[1] };
    }
    return null;
}
