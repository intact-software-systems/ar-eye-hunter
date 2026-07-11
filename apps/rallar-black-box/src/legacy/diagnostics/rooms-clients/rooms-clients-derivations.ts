import { optionalNumber } from '../../shared/finite-number.ts';
import {
    recordArray,
    recordValue as optionalRecord,
} from '../../shared/record-value.ts';
import type {
    ClientSortId,
    ClientStateRow,
    GroupSortId,
    RoomStateRow,
    StateEventRow,
} from './rooms-clients-contracts.ts';

function numberOrZero(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function auditAtEpochMs(value: unknown): number | undefined {
    return optionalNumber(optionalRecord(value).atEpochMs);
}

function maxNumber(
    values: readonly (number | undefined)[],
): number | undefined {
    const numbers = values.filter(
        (value): value is number => value !== undefined,
    );
    return numbers.length > 0 ? Math.max(...numbers) : undefined;
}

function compareNumberDesc(
    left: number | undefined,
    right: number | undefined,
): number {
    return (
        (right ?? Number.NEGATIVE_INFINITY) - (left ?? Number.NEGATIVE_INFINITY)
    );
}

function compareText(left: string, right: string): number {
    return left.localeCompare(right, undefined, {
        sensitivity: 'base',
        numeric: true,
    });
}

function firstComparison(...comparisons: readonly number[]): number {
    return comparisons.find((value) => value !== 0) ?? 0;
}

function stringOrDash(value: unknown): string {
    return typeof value === 'string' && value.length > 0 ? value : '-';
}

export function rowsFromGroupSnapshots(value: unknown): readonly RoomStateRow[] {
    return recordArray(value).map((snapshot, index) => {
        const group = optionalRecord(snapshot.group);
        const members = recordArray(snapshot.members);
        const activeSessions = recordArray(snapshot.activeSessions);
        const groupId = stringOrDash(group.groupId ?? snapshot.groupId);
        const createdAtEpochMs = auditAtEpochMs(group.created);
        const updatedAtEpochMs = auditAtEpochMs(group.updated);
        const activeAtEpochMs = maxNumber(
            activeSessions.flatMap((session) => [
                optionalNumber(session.lastHeartbeatAtEpochMs),
                optionalNumber(session.connectedAtEpochMs),
            ]),
        );
        const mutatedAtEpochMs = maxNumber([
            updatedAtEpochMs,
            createdAtEpochMs,
            activeAtEpochMs,
            ...members.flatMap((member) => [
                auditAtEpochMs(member.updated),
                auditAtEpochMs(member.joined),
                auditAtEpochMs(member.left),
                auditAtEpochMs(member.removed),
                auditAtEpochMs(member.banned),
            ]),
        ]);
        return {
            rowId: `${groupId}-${index}`,
            groupId,
            displayName: stringOrDash(
                group.displayName ?? group.slug ?? groupId,
            ),
            status: stringOrDash(group.status),
            members: numberOrZero(snapshot.memberCount),
            online: numberOrZero(snapshot.onlineMemberCount),
            sessions: activeSessions.map((session) =>
                stringOrDash(session.sessionId),
            ),
            createdAtEpochMs,
            updatedAtEpochMs,
            activeAtEpochMs,
            mutatedAtEpochMs,
            snapshotVersion: optionalNumber(group.snapshotVersion),
        };
    });
}

export function rowsFromClientSnapshots(value: unknown): readonly ClientStateRow[] {
    return recordArray(value).map((snapshot, index) => {
        const principal = optionalRecord(snapshot.principal);
        const instances = recordArray(snapshot.instances);
        const activeSessions = recordArray(snapshot.activeSessions);
        const principalId = stringOrDash(
            principal.principalId ?? snapshot.principalId,
        );
        const createdAtEpochMs = auditAtEpochMs(principal.created);
        const updatedAtEpochMs = auditAtEpochMs(principal.updated);
        const activeAtEpochMs = maxNumber([
            optionalNumber(snapshot.lastSeenAtEpochMs),
            optionalNumber(principal.lastSeenAtEpochMs),
            ...activeSessions.flatMap((session) => [
                optionalNumber(session.lastHeartbeatAtEpochMs),
                optionalNumber(session.connectedAtEpochMs),
                optionalNumber(session.authenticatedAtEpochMs),
            ]),
        ]);
        const mutatedAtEpochMs = maxNumber([
            updatedAtEpochMs,
            createdAtEpochMs,
            activeAtEpochMs,
            ...instances.flatMap((instance) => [
                auditAtEpochMs(instance.updated),
                auditAtEpochMs(instance.registered),
                auditAtEpochMs(instance.revoked),
            ]),
        ]);
        return {
            rowId: `${principalId}-${index}`,
            principalId,
            username: stringOrDash(
                principal.username ?? principal.displayName ?? principalId,
            ),
            status: stringOrDash(principal.status),
            online: snapshot.isOnline === true ? 'online' : 'offline',
            sessions: activeSessions.map((session) =>
                stringOrDash(session.sessionId),
            ),
            createdAtEpochMs,
            updatedAtEpochMs,
            activeAtEpochMs,
            mutatedAtEpochMs,
            snapshotVersion: optionalNumber(principal.snapshotVersion),
        };
    });
}

export function sortGroupRows(
    rows: readonly RoomStateRow[],
    sortId: GroupSortId,
): readonly RoomStateRow[] {
    return [...rows].sort((left, right) => {
        switch (sortId) {
            case 'active-desc':
                return firstComparison(
                    compareNumberDesc(
                        left.activeAtEpochMs,
                        right.activeAtEpochMs,
                    ),
                    right.online - left.online,
                    right.members - left.members,
                    compareText(left.displayName, right.displayName),
                );
            case 'mutated-desc':
                return firstComparison(
                    compareNumberDesc(
                        left.mutatedAtEpochMs,
                        right.mutatedAtEpochMs,
                    ),
                    compareText(left.displayName, right.displayName),
                );
            case 'created-desc':
                return firstComparison(
                    compareNumberDesc(
                        left.createdAtEpochMs,
                        right.createdAtEpochMs,
                    ),
                    compareText(left.displayName, right.displayName),
                );
            case 'online-desc':
                return firstComparison(
                    right.online - left.online,
                    compareNumberDesc(
                        left.activeAtEpochMs,
                        right.activeAtEpochMs,
                    ),
                    compareText(left.displayName, right.displayName),
                );
            case 'members-desc':
                return firstComparison(
                    right.members - left.members,
                    right.online - left.online,
                    compareText(left.displayName, right.displayName),
                );
            case 'status-asc':
                return firstComparison(
                    compareText(left.status, right.status),
                    compareText(left.displayName, right.displayName),
                );
            case 'name-asc':
                return compareText(left.displayName, right.displayName);
        }
    });
}

export function sortClientRows(
    rows: readonly ClientStateRow[],
    sortId: ClientSortId,
): readonly ClientStateRow[] {
    return [...rows].sort((left, right) => {
        switch (sortId) {
            case 'online-active-desc':
                return firstComparison(
                    Number(right.online === 'online') -
                        Number(left.online === 'online'),
                    compareNumberDesc(
                        left.activeAtEpochMs,
                        right.activeAtEpochMs,
                    ),
                    compareText(left.username, right.username),
                );
            case 'active-desc':
                return firstComparison(
                    compareNumberDesc(
                        left.activeAtEpochMs,
                        right.activeAtEpochMs,
                    ),
                    compareText(left.username, right.username),
                );
            case 'mutated-desc':
                return firstComparison(
                    compareNumberDesc(
                        left.mutatedAtEpochMs,
                        right.mutatedAtEpochMs,
                    ),
                    compareText(left.username, right.username),
                );
            case 'created-desc':
                return firstComparison(
                    compareNumberDesc(
                        left.createdAtEpochMs,
                        right.createdAtEpochMs,
                    ),
                    compareText(left.username, right.username),
                );
            case 'sessions-desc':
                return firstComparison(
                    right.sessions.length - left.sessions.length,
                    Number(right.online === 'online') -
                        Number(left.online === 'online'),
                    compareText(left.username, right.username),
                );
            case 'status-asc':
                return firstComparison(
                    compareText(left.status, right.status),
                    compareText(left.username, right.username),
                );
            case 'name-asc':
                return compareText(left.username, right.username);
        }
    });
}

export function rowsFromStateEvents(value: unknown): readonly StateEventRow[] {
    const rows = Array.isArray(value)
        ? value
        : recordArray(optionalRecord(value).events);
    return rows
        .filter(
            (item): item is Record<string, unknown> =>
                Boolean(item) &&
                typeof item === 'object' &&
                !Array.isArray(item),
        )
        .map((event, index) => ({
            rowId: stringOrDash(
                event.eventId ?? `${event.eventType ?? 'event'}-${index}`,
            ),
            eventType: stringOrDash(event.eventType),
            subject: stringOrDash(
                event.groupId ?? event.principalId ?? event.sessionId,
            ),
            snapshotVersion: String(event.snapshotVersion ?? '-'),
            atEpochMs:
                typeof event.occurredAtEpochMs === 'number'
                    ? event.occurredAtEpochMs
                    : undefined,
        }));
}
