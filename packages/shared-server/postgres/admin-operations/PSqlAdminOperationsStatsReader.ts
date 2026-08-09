import type {
  AdminCountByStatus,
  AdminCountByTypeStatus,
  AdminOperationsCrdtResponse,
  AdminOperationsQueuesResponse,
  AdminOperationsStateResponse,
  AdminOperationsSystemResponse,
} from '@shared/api/admin-operations-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type {
  AdminOperationsReadInput,
  AdminOperationsStatsReader,
} from '../../rallar-system/admin-operations/AdminOperationsService.ts';
import type { PSqlSql } from '../PostgresSqlClient.ts';
import {
  decodeGroupStateGroupStorageKey,
  decodeGroupStateMemberStorageKey,
  decodeGroupStatePresenceSessionStorageKey,
  groupStateScopeStorageKey,
} from '../../rallar-system/group-state-storage-keys.ts';
import { groupEventWorkspaceKey } from '../rallar-system/group-event-workspace-key.ts';
import {
  validatePersistedGroup,
  validatePersistedGroupMember,
  validatePersistedGroupPresenceSession,
} from '../../rallar-system/services/group-state-mutations.ts';
import { PSqlClientStateAdminStatsReader } from './p-sql-client-state-admin-stats-reader.ts';

export { PSqlAdminOperationsPruner } from './p-sql-admin-operations-pruner.ts';
const DEFAULT_RECENT_EVENT_WINDOW_MS = 15 * 60 * 1_000;
export type PSqlAdminOperationsStatsReaderOptions = Readonly<{
  now: () => number;
  recentEventWindowMs?: number;
  serverId?: string;
  sqlBackend?: string;
  dbPubSub?: string;
}>;
export class AdminOperationsStateInvariantCorruptionError extends Error {
  readonly code = 'admin-operations-state-invariant-corruption';
  constructor(message: string) {
    super(message);
    this.name = 'AdminOperationsStateInvariantCorruptionError';
  }
}
type CountRow = Readonly<{
  count: number | string | bigint;
}>;
type RuntimeStateRow = Readonly<{
  store_key: string;
  store_value: string;
}>;
type GroupRuntimeStateNamespace =
  | 'group-state:groups'
  | 'group-state:members'
  | 'group-state:sessions';
type QueueTypeStatusRow = Readonly<{
  type_id: string;
  status: string;
  count: number | string | bigint;
}>;
type StatusCountRow = Readonly<{
  status: string;
  count: number | string | bigint;
}>;
type CrrdtScopeTypeRow = Readonly<{
  document_scope: string;
  document_type: string;
  count: number | string | bigint;
}>;
type CrdtStorageRow = Readonly<{
  updates: number | string | bigint | null;
  snapshots: number | string | bigint | null;
  stored_update_bytes: number | string | bigint | null;
}>;
export class PSqlAdminOperationsStatsReader implements AdminOperationsStatsReader {
  private readonly clientStateStatsReader: PSqlClientStateAdminStatsReader;

  constructor(
    private readonly sql: PSqlSql,
    private readonly options: PSqlAdminOperationsStatsReaderOptions,
  ) {
    this.clientStateStatsReader = new PSqlClientStateAdminStatsReader(sql, options);
  }
  async readQueues(_input: AdminOperationsReadInput): Promise<AdminOperationsQueuesResponse> {
    const [queueTotal, queueExpired, queueGroups, resultTotal, resultExpired, resultGroups] =
      await Promise.all([
        this.countRows('resource_inbox'),
        this.countExpired('resource_inbox', 'expire_ts'),
        this.queueGroups('resource_inbox'),
        this.countRows('resource_inbox_results'),
        this.countExpired('resource_inbox_results', 'expire_ts'),
        this.queueGroups('resource_inbox_results'),
      ]);
    return {
      ...this.base(),
      queueRows: {
        total: queueTotal,
        expired: queueExpired,
        byTypeStatus: queueGroups,
        topPressure: toTopPressure(queueGroups),
      },
      resultRows: {
        total: resultTotal,
        expired: resultExpired,
        byTypeStatus: resultGroups,
        topPressure: toTopPressure(resultGroups),
      },
    };
  }
  async readState(input: AdminOperationsReadInput): Promise<AdminOperationsStateResponse> {
    if (!input.scope) {
      return await this.readGlobalState();
    }
    const scope = input.scope;
    const [
      clientFacts, groupRows, memberRows, groupSessionRows,
      recentClientEvents, recentGroupEvents,
    ] = await Promise.all([
      this.clientStateStatsReader.readScopedFacts(scope),
      this.readLiveRuntimeRows('group-state:groups', scope),
      this.readLiveRuntimeRows('group-state:members', scope),
      this.readLiveRuntimeRows('group-state:sessions', scope),
      this.clientStateStatsReader.countRecentEvents(scope),
      this.countRecentGroupEvents(scope),
    ]);
    validateScopedGroupRuntimeRows('group-state:groups', groupRows, scope);
    validateScopedGroupRuntimeRows('group-state:members', memberRows, scope);
    validateScopedGroupRuntimeRows('group-state:sessions', groupSessionRows, scope);
    const cutoffEpochMs = this.options.now();
    const clientStats = this.clientStateStatsReader.summarizeScoped(clientFacts, cutoffEpochMs);
    const activeMembers = memberRows.filter(isActiveGroupMemberRow);
    const onlineGroupMemberIds = new Set(
      groupSessionRows
        .filter((row) => isActiveGroupSessionRow(row, cutoffEpochMs))
        .map((row) => readCanonicalGroupMemberIdentity(row, 'session'))
        .filter((identity): identity is string => identity !== undefined),
    );
    return {
      ...this.base(scope),
      clients: clientStats,
      groups: {
        activeGroups: groupRows.filter((row) => isActiveGroupRow(row, cutoffEpochMs)).length,
        totalActiveMembers: activeMembers.length,
        onlineMembers: activeMembers.filter((member) => {
          const identity = readCanonicalGroupMemberIdentity(member, 'member');
          return identity !== undefined && onlineGroupMemberIds.has(identity);
        }).length,
      },
      events: {
        recentClientEvents,
        recentGroupEvents,
      },
    };
  }
  private async readGlobalState(): Promise<AdminOperationsStateResponse> {
    const [
      clientStats,
      groupRows,
      memberRows,
      groupSessionRows,
      recentClientEvents,
      recentGroupEvents,
    ] = await Promise.all([
      this.clientStateStatsReader.readGlobal(),
      this.readLiveRuntimeRows('group-state:groups', undefined),
      this.readLiveRuntimeRows('group-state:members', undefined),
      this.readLiveRuntimeRows('group-state:sessions', undefined),
      this.clientStateStatsReader.countRecentEvents(),
      this.countRecentGroupEvents(),
    ]);
    validateScopedGroupRuntimeRows('group-state:groups', groupRows);
    validateScopedGroupRuntimeRows('group-state:members', memberRows);
    validateScopedGroupRuntimeRows('group-state:sessions', groupSessionRows);
    const cutoffEpochMs = this.options.now();
    const activeMembers = memberRows.filter(isActiveGroupMemberRow);
    const onlineGroupMemberIds = new Set(
      groupSessionRows
        .filter((row) => isActiveGroupSessionRow(row, cutoffEpochMs))
        .map((row) => readCanonicalGroupMemberIdentity(row, 'session'))
        .filter((identity): identity is string => identity !== undefined),
    );
    return {
      ...this.base(),
      clients: clientStats,
      groups: {
        activeGroups: groupRows.filter((row) => isActiveGroupRow(row, cutoffEpochMs)).length,
        totalActiveMembers: activeMembers.length,
        onlineMembers: activeMembers.filter((member) => {
          const identity = readCanonicalGroupMemberIdentity(member, 'member');
          return identity !== undefined && onlineGroupMemberIds.has(identity);
        }).length,
      },
      events: {
        recentClientEvents,
        recentGroupEvents,
      },
    };
  }
  async readCrdt(input: AdminOperationsReadInput): Promise<AdminOperationsCrdtResponse> {
    const scope = input.scope;
    const [total, byLifecycle, byScopeType, storage] = await Promise.all([
      this.countCrdtDocuments(scope),
      this.countCrdtByLifecycle(scope),
      this.countCrdtByScopeType(scope),
      this.readCrdtStorage(scope),
    ]);
    return {
      ...this.base(scope),
      documents: {
        total,
        byLifecycle,
        byScopeType,
      },
      storage,
    };
  }
  async readSystem(_input: AdminOperationsReadInput): Promise<AdminOperationsSystemResponse> {
    const [
      runtimeRows,
      runtimeExpiredRows,
      runtimeByNamespace,
      appDataRows,
      appDataExpiredRows,
      appDataByNamespaceStore,
      clientEvents,
      groupEvents,
    ] = await Promise.all([
      this.countRows('runtime_state_store'),
      this.countExpired('runtime_state_store', 'expire_at_ts'),
      this.countRuntimeByNamespace(),
      this.countRows('app_data_store'),
      this.countExpired('app_data_store', 'expire_at_ts'),
      this.countAppDataByNamespaceStore(),
      this.clientStateStatsReader.countEvents(),
      this.countGroupEvents(),
    ]);
    return {
      ...this.base(),
      runtimeState: {
        rows: runtimeRows,
        expiredRows: runtimeExpiredRows,
        byNamespace: runtimeByNamespace,
      },
      appData: {
        rows: appDataRows,
        expiredRows: appDataExpiredRows,
        byNamespaceStore: appDataByNamespaceStore,
      },
      stateEvents: {
        clientEvents,
        groupEvents,
      },
      configuration: {
        sqlBackend: this.options.sqlBackend,
        dbPubSub: this.options.dbPubSub,
      },
    };
  }
  private base(scope?: StateScope) {
    return {
      generatedAtEpochMs: this.options.now(),
      serverId: this.options.serverId,
      scope,
      warnings: [],
    };
  }
  private async countRows(table: string): Promise<number> {
    switch (table) {
      case 'resource_inbox':
        return toNumber(
          (await this.sql<CountRow[]>`
                    select count(*) as count from resource_inbox
                `)[0]?.count,
        );
      case 'resource_inbox_results':
        return toNumber(
          (await this.sql<CountRow[]>`
                    select count(*) as count from resource_inbox_results
                `)[0]?.count,
        );
      case 'runtime_state_store':
        return toNumber(
          (await this.sql<CountRow[]>`
                    select count(*) as count from runtime_state_store
                `)[0]?.count,
        );
      case 'app_data_store':
        return toNumber(
          (await this.sql<CountRow[]>`
                    select count(*) as count from app_data_store
                `)[0]?.count,
        );
      default:
        throw new Error(`Unsupported admin count table: ${table}`);
    }
  }
  private async countExpired(table: string, column: string): Promise<number> {
    if (table === 'resource_inbox' && column === 'expire_ts') {
      return toNumber(
        (await this.sql<CountRow[]>`
                select count(*) as count from resource_inbox where expire_ts <= now()
            `)[0]?.count,
      );
    }
    if (table === 'resource_inbox_results' && column === 'expire_ts') {
      return toNumber(
        (await this.sql<CountRow[]>`
                select count(*) as count from resource_inbox_results where expire_ts <= now()
            `)[0]?.count,
      );
    }
    if (table === 'runtime_state_store' && column === 'expire_at_ts') {
      return toNumber(
        (await this.sql<CountRow[]>`
                select count(*) as count from runtime_state_store where expire_at_ts <= now()
            `)[0]?.count,
      );
    }
    if (table === 'app_data_store' && column === 'expire_at_ts') {
      return toNumber(
        (await this.sql<CountRow[]>`
                select count(*) as count from app_data_store where expire_at_ts <= now()
            `)[0]?.count,
      );
    }
    throw new Error(`Unsupported admin expired count: ${table}.${column}`);
  }
  private async queueGroups(
    table: 'resource_inbox' | 'resource_inbox_results',
  ): Promise<readonly AdminCountByTypeStatus[]> {
    const rows = table === 'resource_inbox'
      ? await this.sql<QueueTypeStatusRow[]>`
                select ri_type_id as type_id, ri_status as status, count(*) as count
                from resource_inbox
                group by ri_type_id, ri_status
                order by ri_type_id, ri_status
            `
      : await this.sql<QueueTypeStatusRow[]>`
                select ris_type_id as type_id, ris_status as status, count(*) as count
                from resource_inbox_results
                group by ris_type_id, ris_status
                order by ris_type_id, ris_status
            `;
    return rows.map(toTypeStatusCount);
  }

  private async readLiveRuntimeRows(
    namespace: GroupRuntimeStateNamespace,
    scope: StateScope | undefined,
  ): Promise<readonly RuntimeStateRow[]> {
    const prefix = scope ? `${groupStateScopeStorageKey(scope)}:` : undefined;
    let rows: readonly RuntimeStateRow[];
    if (prefix) {
      const prefixEnd = toExclusivePrefixEnd(prefix);
      rows = await this.sql<RuntimeStateRow[]>`
                select store_key, store_value
                from runtime_state_store
                where store_namespace = ${namespace}
                  and store_key collate "C" >= ${prefix}
                  and store_key collate "C" < ${prefixEnd}
                  and expire_at_ts > now()
                order by store_key collate "C"
            `;
    } else {
      rows = await this.sql<RuntimeStateRow[]>`
            select store_key, store_value
            from runtime_state_store
            where store_namespace = ${namespace}
              and expire_at_ts > now()
            order by store_key
        `;
    }
    return rows;
  }

  private async countGroupEvents(scope?: StateScope): Promise<number> {
    if (scope) {
      return toNumber(
        (await this.sql<CountRow[]>`
                select count(*) as count
                from group_state_events
                where application_id = ${scope.applicationId}
                  and workspace_key = ${groupEventWorkspaceKey(scope.workspaceId)}
            `)[0]?.count,
      );
    }
    return toNumber(
      (await this.sql<CountRow[]>`
            select count(*) as count from group_state_events
        `)[0]?.count,
    );
  }

  private async countRecentGroupEvents(scope?: StateScope): Promise<number> {
    const recentSinceEpochMs = this.options.now() -
      (this.options.recentEventWindowMs ?? DEFAULT_RECENT_EVENT_WINDOW_MS);
    if (scope) {
      return toNumber(
        (await this.sql<CountRow[]>`
                select count(*) as count
                from group_state_events
                where application_id = ${scope.applicationId}
                  and workspace_key = ${groupEventWorkspaceKey(scope.workspaceId)}
                  and occurred_at_epoch_ms >= ${recentSinceEpochMs}
            `)[0]?.count,
      );
    }
    return toNumber(
      (await this.sql<CountRow[]>`
            select count(*) as count
            from group_state_events
            where occurred_at_epoch_ms >= ${recentSinceEpochMs}
        `)[0]?.count,
    );
  }

  private async countCrdtDocuments(scope?: StateScope): Promise<number> {
    if (scope) {
      return toNumber(
        (await this.sql<CountRow[]>`
                select count(*) as count
                from crdt_documents
                where application_id = ${scope.applicationId}
                  and workspace_id = ${scope.workspaceId}
            `)[0]?.count,
      );
    }
    return toNumber(
      (await this.sql<CountRow[]>`
            select count(*) as count from crdt_documents
        `)[0]?.count,
    );
  }

  private async countCrdtByLifecycle(scope?: StateScope): Promise<readonly AdminCountByStatus[]> {
    const rows = scope
      ? await this.sql<StatusCountRow[]>`
                select lifecycle as status, count(*) as count
                from crdt_documents
                where application_id = ${scope.applicationId}
                  and workspace_id = ${scope.workspaceId}
                group by lifecycle
                order by lifecycle
            `
      : await this.sql<StatusCountRow[]>`
                select lifecycle as status, count(*) as count
                from crdt_documents
                group by lifecycle
                order by lifecycle
            `;
    return rows.map(toStatusCount);
  }

  private async countCrdtByScopeType(
    scope?: StateScope,
  ): Promise<readonly AdminCountByTypeStatus[]> {
    const rows = scope
      ? await this.sql<CrrdtScopeTypeRow[]>`
                select document_scope, document_type, count(*) as count
                from crdt_documents
                where application_id = ${scope.applicationId}
                  and workspace_id = ${scope.workspaceId}
                group by document_scope, document_type
                order by document_scope, document_type
            `
      : await this.sql<CrrdtScopeTypeRow[]>`
                select document_scope, document_type, count(*) as count
                from crdt_documents
                group by document_scope, document_type
                order by document_scope, document_type
            `;
    return rows.map((row) => ({
      typeId: row.document_scope,
      status: row.document_type,
      count: toNumber(row.count),
    }));
  }

  private async readCrdtStorage(scope?: StateScope) {
    const row = scope
      ? (await this.sql<CrdtStorageRow[]>`
                select
                    coalesce(sum(update_count), 0) as updates,
                    coalesce(sum(snapshot_count), 0) as snapshots,
                    coalesce(sum(stored_update_bytes), 0) as stored_update_bytes
                from crdt_documents
                where application_id = ${scope.applicationId}
                  and workspace_id = ${scope.workspaceId}
            `)[0]
      : (await this.sql<CrdtStorageRow[]>`
                select
                    coalesce(sum(update_count), 0) as updates,
                    coalesce(sum(snapshot_count), 0) as snapshots,
                    coalesce(sum(stored_update_bytes), 0) as stored_update_bytes
                from crdt_documents
            `)[0];
    return {
      updates: toNumber(row?.updates),
      snapshots: toNumber(row?.snapshots),
      storedUpdateBytes: toNumber(row?.stored_update_bytes),
    };
  }

  private async countRuntimeByNamespace(): Promise<readonly AdminCountByStatus[]> {
    const rows = await this.sql<StatusCountRow[]>`
            select store_namespace as status, count(*) as count
            from runtime_state_store
            group by store_namespace
            order by store_namespace
        `;
    return rows.map(toStatusCount);
  }

  private async countAppDataByNamespaceStore(): Promise<readonly AdminCountByTypeStatus[]> {
    const rows = await this.sql<QueueTypeStatusRow[]>`
            select app_namespace as type_id, store_name as status, count(*) as count
            from app_data_store
            group by app_namespace, store_name
            order by app_namespace, store_name
        `;
    return rows.map(toTypeStatusCount);
  }
}

function validateScopedGroupRuntimeRows(
  namespace: string,
  rows: readonly RuntimeStateRow[],
  scope?: StateScope,
): void {
  for (const row of rows) {
    let decoded: Readonly<Record<string, string | undefined>>;
    let value: Readonly<Record<string, unknown>>;
    try {
      decoded = namespace === 'group-state:groups'
        ? decodeGroupStateGroupStorageKey(row.store_key)
        : namespace === 'group-state:members'
        ? decodeGroupStateMemberStorageKey(row.store_key)
        : namespace === 'group-state:sessions'
        ? decodeGroupStatePresenceSessionStorageKey(row.store_key)
        : (() => {
          throw new TypeError(`Unsupported scoped group namespace: ${namespace}`);
        })();
      const parsed = JSON.parse(row.store_value);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new TypeError('Stored group runtime value is not an object');
      }
      value = parsed as Readonly<Record<string, unknown>>;
      const ref = decoded as GroupRef;
      if (namespace === 'group-state:groups') {
        validatePersistedGroup(parsed, ref);
      } else if (namespace === 'group-state:members') {
        validatePersistedGroupMember(parsed, ref);
      } else {
        validatePersistedGroupPresenceSession(parsed, ref);
      }
    } catch (error) {
      throw new AdminOperationsStateInvariantCorruptionError(
        error instanceof Error ? error.message : 'Stored group runtime row is invalid',
      );
    }
    if (
      (scope !== undefined &&
        (decoded.applicationId !== scope.applicationId ||
          decoded.workspaceId !== scope.workspaceId)) ||
      value.applicationId !== decoded.applicationId ||
      value.workspaceId !== decoded.workspaceId ||
      value.groupId !== decoded.groupId ||
      ('principalId' in decoded && value.principalId !== decoded.principalId) ||
      ('sessionId' in decoded && value.sessionId !== decoded.sessionId)
    ) {
      throw new AdminOperationsStateInvariantCorruptionError(
        `Stored group runtime identity differs from its scoped slot: ${row.store_key}`,
      );
    }
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

function toNumber(value: unknown): number {
  if (value === undefined || value === null) {
    return 0;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function toStatusCount(row: StatusCountRow): AdminCountByStatus {
  return {
    status: row.status,
    count: toNumber(row.count),
  };
}

function toTypeStatusCount(row: QueueTypeStatusRow): AdminCountByTypeStatus {
  return {
    typeId: row.type_id,
    status: row.status,
    count: toNumber(row.count),
  };
}

function toTopPressure(
  rows: readonly AdminCountByTypeStatus[],
): readonly AdminCountByTypeStatus[] {
  return [...rows]
    .sort((left, right) =>
      right.count - left.count ||
      left.typeId.localeCompare(right.typeId) ||
      left.status.localeCompare(right.status)
    )
    .slice(0, 10);
}

function isActiveGroupRow(row: RuntimeStateRow, nowEpochMs: number): boolean {
  const value = readRuntimeStateValue(row);
  return value.status === 'active' && isAbsentOrFutureEpochMs(value.expiresAtEpochMs, nowEpochMs);
}

function isActiveGroupMemberRow(row: RuntimeStateRow): boolean {
  return readRuntimeStateValue(row).status === 'active';
}

function isActiveGroupSessionRow(row: RuntimeStateRow, nowEpochMs: number): boolean {
  const value = readRuntimeStateValue(row);
  return value.disconnectedAtEpochMs === null &&
    isFutureEpochMs(value.expiresAtEpochMs, nowEpochMs);
}

function readCanonicalGroupMemberIdentity(
  row: RuntimeStateRow,
  kind: 'member' | 'session',
): string | undefined {
  const decoded = kind === 'member'
    ? decodeGroupStateMemberStorageKey(row.store_key)
    : decodeGroupStatePresenceSessionStorageKey(row.store_key);
  const principalId = readString(readRuntimeStateValue(row).principalId);
  if (principalId === undefined) return undefined;
  return JSON.stringify([
    decoded.applicationId,
    decoded.workspaceId === undefined
      ? ['workspace-absent']
      : ['workspace-present', decoded.workspaceId],
    decoded.groupId,
    principalId,
  ]);
}

function isFutureEpochMs(value: unknown, nowEpochMs: number): boolean {
  const epochMs = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(epochMs) && epochMs > nowEpochMs;
}

function isAbsentOrFutureEpochMs(value: unknown, nowEpochMs: number): boolean {
  return value === undefined || value === null ||
    (typeof value === 'number' && Number.isFinite(value) && value > nowEpochMs);
}

function readRuntimeStateValue(row: RuntimeStateRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.store_value);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
