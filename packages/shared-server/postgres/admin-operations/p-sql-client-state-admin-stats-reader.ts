import type { StateScope } from '@shared/api/state-types.ts';
import {
  isClientJsonObject,
} from '../../rallar-system/client-state/client-state-semantic-equality.ts';
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

export type ClientStateAdminActivityStats = Readonly<{
  totalPrincipals: number;
  onlinePrincipals: number;
  activeSessions: number;
}>;

export type PSqlClientStateAdminStatsReaderOptions = Readonly<{
  recentEventWindowMs?: number;
}>;

type ClientStateAdminScopedFacts = Readonly<{
  totalPrincipals: number;
  sessionRows: readonly RuntimeStateRow[];
}>;

export class PSqlClientStateAdminStatsReader {
  constructor(
    private readonly sql: PSqlSql,
    private readonly options: PSqlClientStateAdminStatsReaderOptions,
  ) {}

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
      totalPrincipals: principalRows.length,
      sessionRows,
    };
  }

  summarizeScoped(
    facts: ClientStateAdminScopedFacts,
    activityCutoffEpochMs: number,
  ): ClientStateAdminActivityStats {
    const activeSessions = facts.sessionRows.filter((row) =>
      isActiveClientSessionRow(row, activityCutoffEpochMs),
    );
    const onlinePrincipalIds = new Set(
      activeSessions
        .map(readClientPrincipalIdentity)
        .filter((identity): identity is string => identity !== undefined),
    );
    return {
      totalPrincipals: facts.totalPrincipals,
      onlinePrincipals: onlinePrincipalIds.size,
      activeSessions: activeSessions.length,
    };
  }

  async readGlobal(activityCutoffEpochMs: number): Promise<ClientStateAdminActivityStats> {
    const [totalPrincipals, onlinePrincipals, activeSessions] = await Promise.all([
      this.countLivePrincipals(),
      this.countActivePrincipals(activityCutoffEpochMs),
      this.countActiveSessions(activityCutoffEpochMs),
    ]);
    return {
      totalPrincipals,
      onlinePrincipals,
      activeSessions,
    };
  }

  async countRecentEvents(
    scope: StateScope | undefined,
    observedAtEpochMs: number,
  ): Promise<number> {
    const recentSinceEpochMs =
      observedAtEpochMs - (this.options.recentEventWindowMs ?? DEFAULT_RECENT_EVENT_WINDOW_MS);
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
    return toNumber(
      (
        await this.sql<CountRow[]>`
        select count(*) as count
        from runtime_state_store
        where store_namespace = 'client-state:principals'
          and expire_at_ts > now()
      `
      )[0]?.count,
    );
  }

  private async countActiveSessions(activityCutoffEpochMs: number): Promise<number> {
    return toNumber(
      (
        await this.sql<CountRow[]>`
        select count(*) as count
        from runtime_state_store
        where store_namespace = 'client-state:sessions'
          and expire_at_ts > now()
          and store_value::jsonb ->> 'status' = 'active'
          and store_value::jsonb ->> 'disconnectedAtEpochMs' is null
          and (store_value::jsonb ->> 'expiresAtEpochMs')::double precision >
            ${activityCutoffEpochMs}
      `
      )[0]?.count,
    );
  }

  private async countActivePrincipals(activityCutoffEpochMs: number): Promise<number> {
    return toNumber(
      (
        await this.sql<CountRow[]>`
        select count(*) as count
        from (
          select distinct store_value::jsonb ->> 'applicationId' as application_id,
            store_value::jsonb ->> 'workspaceId' as workspace_id,
            store_value::jsonb ->> 'principalId' as principal_id
          from runtime_state_store
          where store_namespace = 'client-state:sessions'
            and expire_at_ts > now()
            and store_value::jsonb ->> 'status' = 'active'
            and store_value::jsonb ->> 'disconnectedAtEpochMs' is null
            and jsonb_typeof(store_value::jsonb -> 'applicationId') = 'string'
            and store_value::jsonb ->> 'applicationId' <> ''
            and jsonb_typeof(store_value::jsonb -> 'workspaceId') = 'string'
            and store_value::jsonb ->> 'workspaceId' <> ''
            and jsonb_typeof(store_value::jsonb -> 'principalId') = 'string'
            and store_value::jsonb ->> 'principalId' <> ''
            and (store_value::jsonb ->> 'expiresAtEpochMs')::double precision >
              ${activityCutoffEpochMs}
        ) principals
      `
      )[0]?.count,
    );
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

function isActiveClientSessionRow(row: RuntimeStateRow, nowEpochMs: number): boolean {
  const value = readRuntimeStateValue(row);
  return (
    value.status === 'active' &&
    value.disconnectedAtEpochMs === undefined &&
    isFutureEpochMs(value.expiresAtEpochMs, nowEpochMs)
  );
}

function readClientPrincipalIdentity(row: RuntimeStateRow): string | undefined {
  const value = readRuntimeStateValue(row);
  const applicationId = readString(value.applicationId);
  const workspaceId = readString(value.workspaceId);
  const principalId = readString(value.principalId);
  return applicationId !== undefined && workspaceId !== undefined && principalId !== undefined
    ? [applicationId, workspaceId, principalId].join('\u001f')
    : undefined;
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

function readString(value: ClientValidationRecord[string]): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toNumber(value: CountRow['count'] | null | undefined): number {
  if (value === undefined || value === null) return 0;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}
