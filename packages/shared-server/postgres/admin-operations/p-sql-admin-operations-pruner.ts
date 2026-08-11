import type { AdminPruneExpiredCategory } from '@shared/api/admin-operations-types.ts';
import type {
  AdminOperationsPruner,
} from '../../rallar-system/admin-operations/AdminOperationsService.ts';
import type {
  AdminPruneExpiredOptions,
} from '../../rallar-system/admin-operations/admin-prune-options.ts';
import type { PSqlSql } from '../PostgresSqlClient.ts';

type CountRow = Readonly<{
  count: number | string | bigint;
}>;

export class PSqlAdminOperationsPruner implements AdminOperationsPruner {
  private readonly sql: PSqlSql;

  constructor(sql: PSqlSql) {
    this.sql = sql;
  }

  async countExpired(
    category: AdminPruneExpiredCategory,
    options: AdminPruneExpiredOptions,
  ): Promise<number> {
    switch (category) {
      case 'runtime-state':
        return toNumber(
          (
            await this.sql<CountRow[]>`
            select count(*) as count from runtime_state_store
            where expire_at_ts <= ${new Date(options.cutoffEpochMs)}
          `
          )[0]?.count,
        );
      case 'resource-inbox':
        return toNumber(
          (
            await this.sql<CountRow[]>`
            select count(*) as count from resource_inbox
            where expire_ts <= ${new Date(options.cutoffEpochMs)}
          `
          )[0]?.count,
        );
      case 'resource-inbox-results':
        return toNumber(
          (
            await this.sql<CountRow[]>`
            select count(*) as count from resource_inbox_results
            where expire_ts <= ${new Date(options.cutoffEpochMs)}
          `
          )[0]?.count,
        );
      case 'app-data':
        return await this.countExpiredAppData(options);
    }
  }

  async pruneExpired(
    category: AdminPruneExpiredCategory,
    options: AdminPruneExpiredOptions,
  ): Promise<number> {
    switch (category) {
      case 'runtime-state':
        return (
          await this.sql<{ store_key: string }[]>`
          with expired as (
            select store_namespace, store_key from runtime_state_store
            where expire_at_ts <= ${new Date(options.cutoffEpochMs)}
            order by store_namespace, store_key limit 100
          )
          delete from runtime_state_store
          where (store_namespace, store_key) in (
            select store_namespace, store_key from expired
          )
          returning store_key
        `
        ).length;
      case 'resource-inbox':
        return (
          await this.sql<{ ri_row_id: string | number }[]>`
          with expired as (
            select ri_row_id from resource_inbox
            where expire_ts <= ${new Date(options.cutoffEpochMs)}
            order by ri_row_id limit 100
          )
          delete from resource_inbox
          where ri_row_id in (select ri_row_id from expired)
          returning ri_row_id
        `
        ).length;
      case 'resource-inbox-results':
        return (
          await this.sql<{ ris_row_id: string | number }[]>`
          with expired as (
            select ris_row_id from resource_inbox_results
            where expire_ts <= ${new Date(options.cutoffEpochMs)}
            order by ris_row_id limit 100
          )
          delete from resource_inbox_results
          where ris_row_id in (select ris_row_id from expired)
          returning ris_row_id
        `
        ).length;
      case 'app-data':
        return await this.pruneExpiredAppData(options);
    }
  }

  private async countExpiredAppData(options: AdminPruneExpiredOptions): Promise<number> {
    const namespace = requireAppDataNamespace(options);
    if (options.appData?.storeName) {
      return toNumber(
        (
          await this.sql<CountRow[]>`
          select count(*) as count
          from app_data_store
          where app_namespace = ${namespace}
            and store_name = ${options.appData.storeName}
            and expire_at_ts <= ${new Date(options.cutoffEpochMs)}
        `
        )[0]?.count,
      );
    }
    return toNumber(
      (
        await this.sql<CountRow[]>`
        select count(*) as count
        from app_data_store
        where app_namespace = ${namespace}
          and expire_at_ts <= ${new Date(options.cutoffEpochMs)}
      `
      )[0]?.count,
    );
  }

  private async pruneExpiredAppData(options: AdminPruneExpiredOptions): Promise<number> {
    const namespace = requireAppDataNamespace(options);
    if (options.appData?.storeName) {
      return (
        await this.sql<{ data_key: string }[]>`
        with expired as (
          select data_key from app_data_store
          where app_namespace = ${namespace}
            and store_name = ${options.appData.storeName}
            and expire_at_ts <= ${new Date(options.cutoffEpochMs)}
          order by data_key limit 100
        )
        delete from app_data_store
        where app_namespace = ${namespace}
          and store_name = ${options.appData.storeName}
          and data_key in (select data_key from expired)
        returning data_key
      `
      ).length;
    }
    return (
      await this.sql<{ data_key: string }[]>`
      with expired as (
        select store_name, data_key from app_data_store
        where app_namespace = ${namespace}
          and expire_at_ts <= ${new Date(options.cutoffEpochMs)}
        order by store_name, data_key limit 100
      )
      delete from app_data_store
      where app_namespace = ${namespace}
        and (store_name, data_key) in (select store_name, data_key from expired)
      returning data_key
    `
    ).length;
  }
}

function requireAppDataNamespace(options: AdminPruneExpiredOptions): string {
  const namespace = options.appData?.namespace;
  if (!namespace) {
    throw new Error('appData.namespace is required for app-data pruning.');
  }
  return namespace;
}

function toNumber(value: CountRow['count'] | null | undefined): number {
  if (value === undefined || value === null) return 0;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}
