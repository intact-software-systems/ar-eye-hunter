import type { ClientPrincipalRef, ClientSessionRef } from '@shared/api/client-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import {
  isClientJsonObject,
} from '../../rallar-system/client-state/client-state-semantic-equality.ts';
import {
  decodeClientPrincipalStorageKey,
  decodeClientSessionStorageKey,
} from '../../rallar-system/client-state/persistence/client-state-storage-keys.ts';
import type {
  ClientValidationRecord,
} from '../../rallar-system/client-state/client-state-validation-primitives.ts';
import { clientStateWorkspaceStorageKey } from '../../rallar-system/client-state-storage-keys.ts';
import type { PSqlSql } from '../PostgresSqlClient.ts';

const DEFAULT_RECENT_EVENT_WINDOW_MS = 15 * 60 * 1_000;

type CountRow = Readonly<{
  count: number | string | bigint;
}>;

type RuntimeStateRow = Readonly<{
  store_key: string;
  store_value: string;
}>;

interface CanonicalClientSessionRow {
  readonly ref: ClientSessionRef;
  readonly value: ClientValidationRecord;
}

export type ClientStateAdminActivityStats = Readonly<{
  totalPrincipals: number;
  onlinePrincipals: number;
  activeSessions: number;
}>;

export type PSqlClientStateAdminStatsReaderOptions = Readonly<{
  now: () => number;
  recentEventWindowMs?: number;
}>;

type ClientStateAdminScopedFacts = Readonly<{
  totalPrincipals: number;
  sessionRows: readonly RuntimeStateRow[];
}>;

export class PSqlClientStateAdminStatsReader {
  private readonly sql: PSqlSql;
  private readonly options: PSqlClientStateAdminStatsReaderOptions;

  constructor(
    sql: PSqlSql,
    options: PSqlClientStateAdminStatsReaderOptions,
  ) {
    this.sql = sql;
    this.options = options;
  }

  async countEvents(): Promise<number> {
    return toNumber(
      (
        await this.sql<CountRow[]>`
        select count(*) as count from client_state_events
      `
      )[0]?.count,
    );
  }

  async readScopedFacts(scope: StateScope): Promise<ClientStateAdminScopedFacts> {
    const [principalRows, sessionRows] = await Promise.all([
      this.readLiveRuntimeRows('client-state:principals', scope),
      this.readLiveRuntimeRows('client-state:sessions', scope),
    ]);
    return {
      totalPrincipals: principalRows.filter(isCanonicalClientPrincipalRow).length,
      sessionRows,
    };
  }

  summarizeScoped(
    facts: ClientStateAdminScopedFacts,
    activityCutoffEpochMs: number,
  ): ClientStateAdminActivityStats {
    const activeSessions = computeScopedActiveClientSessionRefs(
      facts.sessionRows,
      activityCutoffEpochMs,
    );
    const onlinePrincipalIds = new Set(activeSessions.map(toClientPrincipalIdentity));
    return {
      totalPrincipals: facts.totalPrincipals,
      onlinePrincipals: onlinePrincipalIds.size,
      activeSessions: activeSessions.length,
    };
  }

  async readGlobal(): Promise<ClientStateAdminActivityStats> {
    const [totalPrincipals, onlinePrincipals, activeSessions] = await Promise.all([
      this.countLivePrincipals(),
      this.countActivePrincipals(this.options.now()),
      this.countActiveSessions(this.options.now()),
    ]);
    return {
      totalPrincipals,
      onlinePrincipals,
      activeSessions,
    };
  }

  async countRecentEvents(scope?: StateScope): Promise<number> {
    const recentSinceEpochMs =
      this.options.now() - (this.options.recentEventWindowMs ?? DEFAULT_RECENT_EVENT_WINDOW_MS);
    if (scope) {
      return toNumber(
        (
          await this.sql<CountRow[]>`
          select count(*) as count
          from client_state_events
          where application_id = ${scope.applicationId}
            and workspace_key = ${clientStateWorkspaceStorageKey(scope.workspaceId)}
            and occurred_at_epoch_ms >= ${recentSinceEpochMs}
        `
        )[0]?.count,
      );
    }
    return toNumber(
      (
        await this.sql<CountRow[]>`
        select count(*) as count
        from client_state_events
        where occurred_at_epoch_ms >= ${recentSinceEpochMs}
      `
      )[0]?.count,
    );
  }

  private async readLiveRuntimeRows(
    namespace: 'client-state:principals' | 'client-state:sessions',
    scope: StateScope,
  ): Promise<readonly RuntimeStateRow[]> {
    const prefix = clientStateScopePrefix(scope);
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
    const rows = await this.readGlobalRuntimeRows('client-state:principals');
    return rows.filter(isCanonicalClientPrincipalRow).length;
  }

  private async countActiveSessions(activityCutoffEpochMs: number): Promise<number> {
    const rows = await this.readGlobalRuntimeRows('client-state:sessions');
    return computeGlobalActiveClientSessionRefs(rows, activityCutoffEpochMs).length;
  }

  private async countActivePrincipals(activityCutoffEpochMs: number): Promise<number> {
    const rows = await this.readGlobalRuntimeRows('client-state:sessions');
    return new Set(
      computeGlobalActiveClientSessionRefs(rows, activityCutoffEpochMs).map(
        toClientPrincipalIdentity,
      ),
    ).size;
  }

  private async readGlobalRuntimeRows(
    namespace: 'client-state:principals' | 'client-state:sessions',
  ): Promise<readonly RuntimeStateRow[]> {
    return await this.sql<RuntimeStateRow[]>`
      select store_key, store_value
      from runtime_state_store
      where store_namespace = ${namespace}
        and expire_at_ts > now()
    `;
  }
}

function clientStateScopePrefix(scope: StateScope): string {
  return [
    `app=${encodeURIComponent(scope.applicationId)}`,
    `ws=${clientStateWorkspaceStorageKey(scope.workspaceId)}`,
    '',
  ].join(':');
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

function computeScopedActiveClientSessionRefs(
  rows: readonly RuntimeStateRow[],
  nowEpochMs: number,
): readonly ClientSessionRef[] {
  return computeCanonicalClientSessionRows(rows)
    .filter(
      (row) =>
        row.value.disconnectedAtEpochMs === undefined &&
        isActiveClientSessionValue(row.value, nowEpochMs),
    )
    .map((row) => row.ref);
}

function computeGlobalActiveClientSessionRefs(
  rows: readonly RuntimeStateRow[],
  nowEpochMs: number,
): readonly ClientSessionRef[] {
  return computeCanonicalClientSessionRows(rows)
    .filter(
      (row) =>
        (row.value.disconnectedAtEpochMs === undefined ||
          row.value.disconnectedAtEpochMs === null) &&
        isActiveClientSessionValue(row.value, nowEpochMs),
    )
    .map((row) => row.ref);
}

function computeCanonicalClientSessionRows(
  rows: readonly RuntimeStateRow[],
): readonly CanonicalClientSessionRow[] {
  return rows
    .map(toCanonicalClientSessionRow)
    .filter((row): row is CanonicalClientSessionRow => row !== undefined);
}

function toCanonicalClientSessionRow(row: RuntimeStateRow): CanonicalClientSessionRow | undefined {
  const value = readRuntimeStateValue(row);
  let ref: ClientSessionRef;
  try {
    ref = decodeClientSessionStorageKey(row.store_key);
  } catch {
    return undefined;
  }
  if (!hasMatchingClientSessionIdentity(value, ref)) {
    return undefined;
  }
  return { ref, value };
}

function isActiveClientSessionValue(value: ClientValidationRecord, nowEpochMs: number): boolean {
  return value.status === 'active' && isFutureEpochMs(value.expiresAtEpochMs, nowEpochMs);
}

function isCanonicalClientPrincipalRow(row: RuntimeStateRow): boolean {
  const value = readRuntimeStateValue(row);
  let ref: ClientPrincipalRef;
  try {
    ref = decodeClientPrincipalStorageKey(row.store_key);
  } catch {
    return false;
  }
  return hasMatchingClientPrincipalIdentity(value, ref);
}

function hasMatchingClientPrincipalIdentity(
  value: ClientValidationRecord,
  ref: ClientPrincipalRef,
): boolean {
  return (
    value.applicationId === ref.applicationId &&
    value.workspaceId === ref.workspaceId &&
    value.principalId === ref.principalId
  );
}

function hasMatchingClientSessionIdentity(
  value: ClientValidationRecord,
  ref: ClientSessionRef,
): boolean {
  return (
    hasMatchingClientPrincipalIdentity(value, ref) &&
    value.clientInstanceId === ref.clientInstanceId &&
    value.sessionId === ref.sessionId
  );
}

function toClientPrincipalIdentity(ref: ClientPrincipalRef): string {
  return [ref.applicationId, ref.workspaceId, ref.principalId].join('\u001f');
}

function isFutureEpochMs(value: ClientValidationRecord[string], nowEpochMs: number): boolean {
  const epochMs = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(epochMs) && epochMs > nowEpochMs;
}

function readRuntimeStateValue(row: RuntimeStateRow): ClientValidationRecord {
  try {
    const parsed = JSON.parse(row.store_value);
    return isClientJsonObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toNumber(value: CountRow['count'] | null | undefined): number {
  if (value === undefined || value === null) return 0;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}
