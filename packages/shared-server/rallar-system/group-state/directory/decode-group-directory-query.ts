import {
    GROUP_DIRECTORY_DEFAULT_LIMIT,
    GROUP_DIRECTORY_MAX_LIMIT,
    type GroupDirectoryOrder
} from '@shared/api/group-directory/group-directory-types.ts';
import type { Group } from '@shared/api/group-types.ts';
import { Either } from '@shared/resilience/Either.ts';

export interface GroupDirectoryCursor {
    readonly order: GroupDirectoryOrder;
    readonly onlineMemberCount: number;
    readonly groupId: string;
    readonly peerRttMs: number | null;
}

export interface GroupDirectoryQuery {
    readonly kind: Group['kind'] | null;
    readonly q: string | null;
    readonly limit: number;
    readonly after: GroupDirectoryCursor | null;
    readonly includeEmpty: boolean;
    readonly order: GroupDirectoryOrder;
}

const GROUP_KINDS: readonly Group['kind'][] = ['party', 'room', 'team', 'custom'];

export function encodeGroupDirectoryCursor(cursor: GroupDirectoryCursor): string {
    const tuple = cursor.order === 'online-members'
        ? [cursor.onlineMemberCount, cursor.groupId]
        : [cursor.order, cursor.onlineMemberCount, cursor.peerRttMs, cursor.groupId];
    const bytes = new TextEncoder().encode(JSON.stringify(tuple));
    return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
}

export function decodeGroupDirectoryQuery(
    searchParams: URLSearchParams
): Either<readonly string[], GroupDirectoryQuery> {
    const issues: string[] = [];
    const kind = decodeKind(searchParams, issues);
    const limit = decodeLimit(searchParams, issues);
    const order = decodeOrder(searchParams, issues);
    const after = decodeCursor(searchParams, order, issues);
    const includeEmpty = decodeIncludeEmpty(searchParams, issues);
    const q = searchParams.get('q')?.trim().toLowerCase() || null;

    return issues.length > 0
        ? Either.ofLeft(issues)
        : Either.ofRight({ kind, q, limit, after, includeEmpty, order });
}

function decodeOrder(searchParams: URLSearchParams, issues: string[]): GroupDirectoryOrder {
    const value = searchParams.get('order');
    if (value === null || value === 'online-members') {
        return 'online-members';
    }
    if (value === 'peer-rtt') {
        return value;
    }
    issues.push('order must be online-members or peer-rtt');
    return 'online-members';
}

function decodeKind(searchParams: URLSearchParams, issues: string[]): Group['kind'] | null {
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

function decodeLimit(searchParams: URLSearchParams, issues: string[]): number {
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

function decodeIncludeEmpty(searchParams: URLSearchParams, issues: string[]): boolean {
    const value = searchParams.get('includeEmpty');
    if (value === null || value === 'false') {
        return false;
    }
    if (value !== 'true') {
        issues.push('includeEmpty must be true or false');
    }
    return value === 'true';
}

function decodeCursor(
    searchParams: URLSearchParams,
    order: GroupDirectoryOrder,
    issues: string[]
): GroupDirectoryCursor | null {
    const value = searchParams.get('cursor');
    if (value === null) {
        return null;
    }
    const cursor = parseCursor(value);
    if (!cursor || cursor.order !== order) {
        issues.push('cursor is not a cursor issued for this directory order');
        return null;
    }
    return cursor;
}

function parseCursor(value: string): GroupDirectoryCursor | null {
    try {
        const padded = value.replaceAll('-', '+').replaceAll('_', '/');
        const binary = atob(padded + '='.repeat((4 - padded.length % 4) % 4));
        const json = new TextDecoder('utf-8', { fatal: true })
            .decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
        return decodeCursorTuple(JSON.parse(json));
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
        return { order: 'online-members', onlineMemberCount: value[0], groupId: value[1], peerRttMs: null };
    }
    if (
        Array.isArray(value) && value.length === 4 && value[0] === 'peer-rtt' &&
        typeof value[1] === 'number' && Number.isSafeInteger(value[1]) && value[1] >= 0 &&
        (value[2] === null || (typeof value[2] === 'number' && Number.isFinite(value[2]) && value[2] > 0)) &&
        typeof value[3] === 'string' && value[3].length > 0
    ) {
        return { order: 'peer-rtt', onlineMemberCount: value[1], peerRttMs: value[2], groupId: value[3] };
    }
    return null;
}
