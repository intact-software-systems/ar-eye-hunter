import type { ClientPrincipalRef, ClientSessionRef } from '@shared/api/client-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { decodeClientPrincipalStorageKey } from '../../client-state/persistence/client-state-principal-storage-key.ts';
import { clientStateScopeStorageKeyPrefix } from '../../client-state/persistence/client-state-scope-storage-key.ts';
import { decodeClientSessionStorageKey } from '../../client-state/persistence/client-state-session-storage-key.ts';
import { clientStateWorkspaceStorageKey } from '../../client-state/persistence/client-state-workspace-storage-key.ts';
import {
    decodeClientValidationRecord,
    type ClientValidationRecord
} from '../../client-state/validation/client-record-validation.ts';

import { decodePSqlAdminCount, type PSqlAdminCountRow } from './decode-p-sql-admin-count.ts';

const DEFAULT_RECENT_EVENT_WINDOW_MS = 15 * 60 * 1_000;

interface RuntimeStateRow {
    readonly store_key: string;
    readonly store_value: string;
}

interface CanonicalClientSessionRow {
    readonly ref: ClientSessionRef;
    readonly value: ClientValidationRecord;
}

export namespace PSqlAdminClientStateReader {
    export interface Options {
        readonly nowEpochMs: () => number;
        readonly recentEventWindowMs?: number;
    }

    export interface ActivityStats {
        readonly totalPrincipals: number;
        readonly onlinePrincipals: number;
        readonly activeSessions: number;
    }

    export interface ScopedFacts {
        readonly totalPrincipals: number;
        readonly sessionRows: readonly RuntimeStateRow[];
    }
}

export class PSqlAdminClientStateReader {
    private readonly sql: PSqlSql;
    private readonly options: PSqlAdminClientStateReader.Options;

    constructor(sql: PSqlSql, options: PSqlAdminClientStateReader.Options) {
        this.sql = sql;
        this.options = options;
    }

    async readScopedFacts(scope: StateScope): Promise<PSqlAdminClientStateReader.ScopedFacts> {
        const [principalRows, sessionRows] = await Promise.all([
            this.readLiveRuntimeRows('client-state:principals', scope),
            this.readLiveRuntimeRows('client-state:sessions', scope)
        ]);
        return {
            totalPrincipals: principalRows.filter(isCanonicalClientPrincipalRow).length,
            sessionRows
        };
    }

    summarizeScoped(
        facts: PSqlAdminClientStateReader.ScopedFacts,
        activityCutoffEpochMs: number
    ): PSqlAdminClientStateReader.ActivityStats {
        const activeSessionRefs = readActiveClientSessionRefs(
            facts.sessionRows,
            activityCutoffEpochMs
        );
        return {
            totalPrincipals: facts.totalPrincipals,
            onlinePrincipals: new Set(activeSessionRefs.map(toClientPrincipalIdentity)).size,
            activeSessions: activeSessionRefs.length
        };
    }

    async readGlobal(): Promise<PSqlAdminClientStateReader.ActivityStats> {
        const [totalPrincipals, onlinePrincipals, activeSessions] = await Promise.all([
            this.countLivePrincipals(),
            this.countActivePrincipals(this.options.nowEpochMs()),
            this.countActiveSessions(this.options.nowEpochMs())
        ]);
        return { totalPrincipals, onlinePrincipals, activeSessions };
    }

    async countRecentEvents(scope?: StateScope): Promise<number> {
        const recentSinceEpochMs = this.options.nowEpochMs() -
            (this.options.recentEventWindowMs ?? DEFAULT_RECENT_EVENT_WINDOW_MS);
        const row = scope
            ? (await this.sql<PSqlAdminCountRow[]>`
                select count(*) as count
                from client_state_events
                where application_id = ${scope.applicationId}
                  and workspace_key = ${clientStateWorkspaceStorageKey(scope.workspaceId)}
                  and occurred_at_epoch_ms >= ${recentSinceEpochMs}
            `)[0]
            : (await this.sql<PSqlAdminCountRow[]>`
                select count(*) as count
                from client_state_events
                where occurred_at_epoch_ms >= ${recentSinceEpochMs}
            `)[0];
        return decodePSqlAdminCount(row?.count);
    }

    private async readLiveRuntimeRows(
        namespace: 'client-state:principals' | 'client-state:sessions',
        scope?: StateScope
    ): Promise<readonly RuntimeStateRow[]> {
        if (!scope) {
            return await this.sql<RuntimeStateRow[]>`
                select store_key, store_value
                from runtime_state_store
                where store_namespace = ${namespace}
                  and expire_at_ts > now()
                order by store_key collate "C"
            `;
        }
        const prefix = clientStateScopeStorageKeyPrefix(scope);
        const prefixEnd = toExclusivePrefixEnd(prefix);
        return await this.sql<RuntimeStateRow[]>`
            select store_key, store_value
            from runtime_state_store
            where store_namespace = ${namespace}
              and store_key collate "C" >= ${prefix}
              and store_key collate "C" < ${prefixEnd}
              and expire_at_ts > now()
            order by store_key collate "C"
        `;
    }

    private async countLivePrincipals(): Promise<number> {
        const rows = await this.readLiveRuntimeRows('client-state:principals');
        return rows.filter(isCanonicalClientPrincipalRow).length;
    }

    private async countActivePrincipals(activityCutoffEpochMs: number): Promise<number> {
        const rows = await this.readLiveRuntimeRows('client-state:sessions');
        return new Set(
            readActiveClientSessionRefs(rows, activityCutoffEpochMs).map(toClientPrincipalIdentity)
        ).size;
    }

    private async countActiveSessions(activityCutoffEpochMs: number): Promise<number> {
        const rows = await this.readLiveRuntimeRows('client-state:sessions');
        return readActiveClientSessionRefs(rows, activityCutoffEpochMs).length;
    }
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

function readActiveClientSessionRefs(
    rows: readonly RuntimeStateRow[],
    nowEpochMs: number
): readonly ClientSessionRef[] {
    return rows
        .map(decodeCanonicalClientSessionRow)
        .filter((row): row is CanonicalClientSessionRow => row !== undefined)
        .filter((row) =>
            (row.value.disconnectedAtEpochMs === undefined ||
                row.value.disconnectedAtEpochMs === null) &&
            row.value.status === 'active' &&
            isFutureEpochMs(row.value.expiresAtEpochMs, nowEpochMs)
        )
        .map((row) => row.ref);
}

function decodeCanonicalClientSessionRow(
    row: RuntimeStateRow
): CanonicalClientSessionRow | undefined {
    const value = decodeClientRuntimeStateValue(row.store_value);
    if (!value) {
        return undefined;
    }
    try {
        const ref = decodeClientSessionStorageKey(row.store_key);
        return hasMatchingClientSessionIdentity(value, ref) ? { ref, value } : undefined;
    }
    catch {
        return undefined;
    }
}

function isCanonicalClientPrincipalRow(row: RuntimeStateRow): boolean {
    const value = decodeClientRuntimeStateValue(row.store_value);
    if (!value) {
        return false;
    }
    try {
        return hasMatchingClientPrincipalIdentity(
            value,
            decodeClientPrincipalStorageKey(row.store_key)
        );
    }
    catch {
        return false;
    }
}

function hasMatchingClientPrincipalIdentity(
    value: ClientValidationRecord,
    ref: ClientPrincipalRef
): boolean {
    return value.applicationId === ref.applicationId &&
        value.workspaceId === ref.workspaceId &&
        value.principalId === ref.principalId;
}

function hasMatchingClientSessionIdentity(
    value: ClientValidationRecord,
    ref: ClientSessionRef
): boolean {
    return hasMatchingClientPrincipalIdentity(value, ref) &&
        value.clientInstanceId === ref.clientInstanceId &&
        value.sessionId === ref.sessionId;
}

function toClientPrincipalIdentity(ref: ClientPrincipalRef): string {
    return JSON.stringify([ref.applicationId, ref.workspaceId, ref.principalId]);
}

function isFutureEpochMs(value: ClientValidationRecord[string], nowEpochMs: number): boolean {
    return typeof value === 'number' && Number.isFinite(value) && value > nowEpochMs;
}

function decodeClientRuntimeStateValue(storeValue: string): ClientValidationRecord | undefined {
    try {
        return decodeClientValidationRecord(JSON.parse(storeValue), 'Admin client runtime state');
    }
    catch {
        return undefined;
    }
}
