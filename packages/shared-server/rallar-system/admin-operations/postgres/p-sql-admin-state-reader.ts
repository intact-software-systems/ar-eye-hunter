import type { AdminOperationsStateResponse } from '@shared/api/admin-operations-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { groupStateScopeStorageKey } from '../../group-state/persistence/group-state-storage-keys.ts';
import { groupStateEventWorkspaceKey } from '../../state-events/postgres/group-state-event-workspace-key.ts';
import type { AdminOperationReadRequest } from '../admin-operation-request.ts';
import { createAdminOperationBaseResponse } from '../admin-operation-response.ts';

import {
    decodeAdminGroupRuntimeRow,
    type AdminGroupMemberRuntimeRow,
    type AdminGroupSessionRuntimeRow,
    type AdminGroupStateRuntimeRow,
    type PSqlAdminRuntimeStateRow
} from './decode-admin-group-runtime-row.ts';
import { decodePSqlAdminCount, type PSqlAdminCountRow } from './decode-p-sql-admin-count.ts';
import { PSqlAdminClientStateReader } from './p-sql-admin-client-state-reader.ts';

const DEFAULT_RECENT_EVENT_WINDOW_MS = 15 * 60 * 1_000;

type GroupRuntimeStateNamespace =
    | 'group-state:groups'
    | 'group-state:members'
    | 'group-state:sessions';

export namespace PSqlAdminStateReader {
    export interface Options {
        readonly nowEpochMs: () => number;
        readonly recentEventWindowMs?: number;
        readonly serverId?: string;
    }
}

interface AdminStateFacts {
    readonly clients: PSqlAdminClientStateReader.ActivityStats;
    readonly groupRows: readonly AdminGroupStateRuntimeRow[];
    readonly memberRows: readonly AdminGroupMemberRuntimeRow[];
    readonly sessionRows: readonly AdminGroupSessionRuntimeRow[];
    readonly recentClientEvents: number;
    readonly recentGroupEvents: number;
    readonly nowEpochMs: number;
    readonly scope?: StateScope;
}

export class PSqlAdminStateReader {
    private readonly clientState: PSqlAdminClientStateReader;
    private readonly sql: PSqlSql;
    private readonly options: PSqlAdminStateReader.Options;

    constructor(sql: PSqlSql, options: PSqlAdminStateReader.Options) {
        this.sql = sql;
        this.options = options;
        this.clientState = new PSqlAdminClientStateReader(sql, options);
    }

    async execute(input: AdminOperationReadRequest): Promise<AdminOperationsStateResponse> {
        return input.scope ? await this.readScoped(input.scope) : await this.readGlobal();
    }

    private async readScoped(scope: StateScope): Promise<AdminOperationsStateResponse> {
        const [clientFacts, groupRows, memberRows, sessionRows, recentClientEvents, recentGroupEvents] = await Promise
            .all([
                this.clientState.readScopedFacts(scope),
                this.readLiveRuntimeRows('group-state:groups', scope),
                this.readLiveRuntimeRows('group-state:members', scope),
                this.readLiveRuntimeRows('group-state:sessions', scope),
                this.clientState.countRecentEvents(scope),
                this.countRecentGroupEvents(scope)
            ]);
        const nowEpochMs = this.options.nowEpochMs();
        const clients = this.clientState.summarizeScoped(clientFacts, nowEpochMs);
        return this.toResponse({
            clients,
            groupRows: decodeGroupStateRuntimeRows(groupRows, scope),
            memberRows: decodeGroupMemberRuntimeRows(memberRows, scope),
            sessionRows: decodeGroupSessionRuntimeRows(sessionRows, scope),
            recentClientEvents,
            recentGroupEvents,
            nowEpochMs,
            scope
        });
    }

    private async readGlobal(): Promise<AdminOperationsStateResponse> {
        const [clients, groupRows, memberRows, sessionRows, recentClientEvents, recentGroupEvents] = await Promise.all([
            this.clientState.readGlobal(),
            this.readLiveRuntimeRows('group-state:groups'),
            this.readLiveRuntimeRows('group-state:members'),
            this.readLiveRuntimeRows('group-state:sessions'),
            this.clientState.countRecentEvents(),
            this.countRecentGroupEvents()
        ]);
        return this.toResponse({
            clients,
            groupRows: decodeGroupStateRuntimeRows(groupRows),
            memberRows: decodeGroupMemberRuntimeRows(memberRows),
            sessionRows: decodeGroupSessionRuntimeRows(sessionRows),
            recentClientEvents,
            recentGroupEvents,
            nowEpochMs: this.options.nowEpochMs()
        });
    }

    private toResponse(input: AdminStateFacts): AdminOperationsStateResponse {
        const activeMembers = input.memberRows.filter(isActiveGroupMember);
        const onlineMemberIdentities = new Set(
            input.sessionRows
                .filter((row) => isActiveGroupSession(row, input.nowEpochMs))
                .map(toGroupMemberIdentity)
        );

        return {
            ...createAdminOperationBaseResponse({ ...this.options, scope: input.scope }),
            clients: input.clients,
            groups: {
                activeGroups: input.groupRows.filter((row) => isActiveGroup(row, input.nowEpochMs)).length,
                totalActiveMembers: activeMembers.length,
                onlineMembers:
                    activeMembers.filter((row) => onlineMemberIdentities.has(toGroupMemberIdentity(row))).length
            },
            events: {
                recentClientEvents: input.recentClientEvents,
                recentGroupEvents: input.recentGroupEvents
            }
        };
    }

    private async readLiveRuntimeRows(
        namespace: GroupRuntimeStateNamespace,
        scope?: StateScope
    ): Promise<readonly PSqlAdminRuntimeStateRow[]> {
        if (!scope) {
            return await this.sql<PSqlAdminRuntimeStateRow[]>`
                select store_key, store_value
                from runtime_state_store
                where store_namespace = ${namespace}
                  and expire_at_ts > now()
                order by store_key collate "C"
            `;
        }
        const prefix = `${groupStateScopeStorageKey(scope)}:`;
        const prefixEnd = toExclusivePrefixEnd(prefix);
        return await this.sql<PSqlAdminRuntimeStateRow[]>`
            select store_key, store_value
            from runtime_state_store
            where store_namespace = ${namespace}
              and store_key collate "C" >= ${prefix}
              and store_key collate "C" < ${prefixEnd}
              and expire_at_ts > now()
            order by store_key collate "C"
        `;
    }

    private async countRecentGroupEvents(scope?: StateScope): Promise<number> {
        const recentSinceEpochMs = this.options.nowEpochMs() -
            (this.options.recentEventWindowMs ?? DEFAULT_RECENT_EVENT_WINDOW_MS);
        const row = scope
            ? (await this.sql<PSqlAdminCountRow[]>`
                select count(*) as count
                from group_state_events
                where application_id = ${scope.applicationId}
                  and workspace_key = ${groupStateEventWorkspaceKey(scope.workspaceId)}
                  and occurred_at_epoch_ms >= ${recentSinceEpochMs}
            `)[0]
            : (await this.sql<PSqlAdminCountRow[]>`
                select count(*) as count
                from group_state_events
                where occurred_at_epoch_ms >= ${recentSinceEpochMs}
            `)[0];
        return decodePSqlAdminCount(row?.count);
    }
}

function decodeGroupStateRuntimeRows(
    rows: readonly PSqlAdminRuntimeStateRow[],
    scope?: StateScope
): readonly AdminGroupStateRuntimeRow[] {
    return rows.map((row) => decodeAdminGroupRuntimeRow('group', row, scope));
}

function decodeGroupMemberRuntimeRows(
    rows: readonly PSqlAdminRuntimeStateRow[],
    scope?: StateScope
): readonly AdminGroupMemberRuntimeRow[] {
    return rows.map((row) => decodeAdminGroupRuntimeRow('member', row, scope));
}

function decodeGroupSessionRuntimeRows(
    rows: readonly PSqlAdminRuntimeStateRow[],
    scope?: StateScope
): readonly AdminGroupSessionRuntimeRow[] {
    return rows.map((row) => decodeAdminGroupRuntimeRow('session', row, scope));
}

function toExclusivePrefixEnd(prefix: string): string {
    if (prefix.length === 0) {
        throw new Error('Runtime state prefix must not be empty.');
    }
    const lastIndex = prefix.length - 1;
    const lastCode = prefix.charCodeAt(lastIndex);
    if (lastCode >= 0x7e) {
        throw new Error(`Runtime state prefix has no safe upper bound: ${prefix}`);
    }
    return `${prefix.slice(0, lastIndex)}${String.fromCharCode(lastCode + 1)}`;
}

function isActiveGroup(row: AdminGroupStateRuntimeRow, nowEpochMs: number): boolean {
    return row.value.status === 'active' &&
        (row.value.expiresAtEpochMs === null || row.value.expiresAtEpochMs > nowEpochMs);
}

function isActiveGroupMember(row: AdminGroupMemberRuntimeRow): boolean {
    return row.value.status === 'active';
}

function isActiveGroupSession(row: AdminGroupSessionRuntimeRow, nowEpochMs: number): boolean {
    return row.value.disconnectedAtEpochMs === null &&
        row.value.expiresAtEpochMs > nowEpochMs;
}

function toGroupMemberIdentity(
    row: AdminGroupMemberRuntimeRow | AdminGroupSessionRuntimeRow
): string {
    return JSON.stringify([
        row.ref.applicationId,
        row.ref.workspaceId,
        row.ref.groupId,
        row.value.principalId
    ]);
}
