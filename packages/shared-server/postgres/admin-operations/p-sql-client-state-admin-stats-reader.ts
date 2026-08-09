import type { StateScope } from '@shared/api/state-types.ts';
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

type RuntimeStateValue = Readonly<{
  applicationId?: string;
  workspaceId?: string;
  principalId?: string;
  status?: string;
  disconnectedAtEpochMs?: number | string | null;
  expiresAtEpochMs?: number | string | null;
}>;

export type ClientStateAdminStats = Readonly<{
  totalPrincipals: number;
  onlinePrincipals: number;
  activeSessions: number;
  recentEvents: number;
}>;

export type PSqlClientStateAdminStatsReaderOptions = Readonly<{
  now: () => number;
  recentEventWindowMs?: number;
}>;

export class PSqlClientStateAdminStatsReader {
  constructor(
    private readonly sql: PSqlSql,
    private readonly options: PSqlClientStateAdminStatsReaderOptions,
  ) {}

  async read(scope?: StateScope): Promise<ClientStateAdminStats> {
    return scope ? await this.readScoped(scope) : await this.readGlobal();
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

  private async readScoped(scope: StateScope): Promise<ClientStateAdminStats> {
    const [principalRows, sessionRows, recentEvents] = await Promise.all([
      this.readLiveRuntimeRows('client-state:principals', scope),
      this.readLiveRuntimeRows('client-state:sessions', scope),
      this.countRecentEvents(scope),
    ]);
    const nowEpochMs = this.options.now();
    const activeSessions = sessionRows.filter((row) => isActiveClientSessionRow(row, nowEpochMs));
    const onlinePrincipalIds = new Set(
      activeSessions
        .map(readClientPrincipalIdentity)
        .filter((identity): identity is string => identity !== undefined),
    );
    return {
      totalPrincipals: principalRows.length,
      onlinePrincipals: onlinePrincipalIds.size,
      activeSessions: activeSessions.length,
      recentEvents,
    };
  }

  private async readGlobal(): Promise<ClientStateAdminStats> {
    const [totalPrincipals, onlinePrincipals, activeSessions, recentEvents] = await Promise.all([
      this.countLivePrincipals(),
      this.countActivePrincipals(),
      this.countActiveSessions(),
      this.countRecentEvents(),
    ]);
    return {
      totalPrincipals,
      onlinePrincipals,
      activeSessions,
      recentEvents,
    };
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

  private async countActiveSessions(): Promise<number> {
    return toNumber(
      (
        await this.sql<CountRow[]>`
        select count(*) as count
        from runtime_state_store
        where store_namespace = 'client-state:sessions'
          and expire_at_ts > now()
          and store_value::jsonb ->> 'status' = 'active'
          and store_value::jsonb ->> 'disconnectedAtEpochMs' is null
          and (store_value::jsonb ->> 'expiresAtEpochMs')::double precision > ${this.options.now()}
      `
      )[0]?.count,
    );
  }

  private async countActivePrincipals(): Promise<number> {
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
            and store_value::jsonb ->> 'applicationId' is not null
            and store_value::jsonb ->> 'workspaceId' is not null
            and store_value::jsonb ->> 'workspaceId' <> ''
            and store_value::jsonb ->> 'principalId' is not null
            and (store_value::jsonb ->> 'expiresAtEpochMs')::double precision >
              ${this.options.now()}
        ) principals
      `
      )[0]?.count,
    );
  }

  private async countRecentEvents(scope?: StateScope): Promise<number> {
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
  const applicationId = readString(value.applicationId) ?? readKeyPart(row.store_key, 'app');
  const workspaceId = readString(value.workspaceId);
  const principalId = readString(value.principalId) ?? readKeyPart(row.store_key, 'principal');
  return applicationId !== undefined && workspaceId !== undefined && principalId !== undefined
    ? [applicationId, workspaceId, principalId].join('\u001f')
    : undefined;
}

function isFutureEpochMs(
  value: number | string | null | undefined,
  nowEpochMs: number,
): boolean {
  const epochMs = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(epochMs) && epochMs > nowEpochMs;
}

function readRuntimeStateValue(row: RuntimeStateRow): RuntimeStateValue {
  try {
    const parsed = JSON.parse(row.store_value) as RuntimeStateValue | null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function readString(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function readKeyPart(key: string, name: string): string | undefined {
  const prefix = `${name}=`;
  const segment = key.split(':').find((part) => part.startsWith(prefix));
  if (!segment) return undefined;
  try {
    const value = decodeURIComponent(segment.slice(prefix.length));
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function toNumber(value: CountRow['count'] | null | undefined): number {
  if (value === undefined || value === null) return 0;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}
