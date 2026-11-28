import { describe, expect, it } from 'vitest';

import { computeSqlWriteFacts } from '../../../../scripts/direct-write-check/sql-write-facts.mjs';
import {
    APP_INBOX_SHAPED_SOURCES,
    createDirectWriteFixture,
    P_SQL_SQL_SOURCE
} from './direct-write-check-fixture.ts';

const BASE_SOURCES = {
    'packages/shared-server/postgres/p-sql-sql.ts': P_SQL_SQL_SOURCE,
    'packages/shared-server/postgres/p-sql-fragment.ts': `
        export class PSqlFragment {
            static of(strings: TemplateStringsArray, ...values: unknown[]): PSqlFragment { void strings; void values; return new PSqlFragment(); }
        }
    `
} as const;

describe('SQL write facts', () => {
    it('does not record a write that a write(transaction, computed) module runs on the AppInbox transaction', () => {
        const facts = computeFixtureFacts(APP_INBOX_SHAPED_SOURCES);

        expect(facts).toEqual({ sqlWriteFiles: [], nonTransactionHandleFeeds: [] });
    });

    it('records each file that runs or builds a write on anything but a transaction parameter, with its statements', () => {
        const facts = computeFixtureFacts({
            'packages/shared-server/app-data/p-sql-app-data-repository.ts': `
                import type { PSqlSql } from '../postgres/p-sql-sql.ts';
                export class PSqlAppDataRepository {
                    constructor(private readonly sql: PSqlSql) {}
                    async remove(key: string): Promise<void> { await this.sql\`delete from app_data_store where key = \${key}\`; }
                }
            `,
            'packages/shared-server/queuebox/postgres/claim-entries.ts': `
                import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
                export async function claimEntries(sql: PSqlSql): Promise<void> {
                    await sql\`select id from resource_inbox for update of resource_inbox\`;
                }
            `,
            'packages/shared-server/runtime-state/postgres/runtime-state-conditional.ts': `
                import { PSqlFragment } from '../../postgres/p-sql-fragment.ts';
                export const conditionalInsert = PSqlFragment.of\`insert into runtime_state_store (store_key) values ('k')\`;
            `,
            'packages/shared-server/runtime-state/postgres/runtime-state-guarded-batch.ts': `
                export const GUARDED_BATCH_SQL_TEXT = ['update runtime_state_store as stored set store_value = ', ' where true'];
            `
        });

        expect(facts.sqlWriteFiles).toEqual([
            { id: 'packages/shared-server/app-data/p-sql-app-data-repository.ts', statements: ['delete:app_data_store'] },
            { id: 'packages/shared-server/queuebox/postgres/claim-entries.ts', statements: ['lock:resource_inbox'] },
            {
                id: 'packages/shared-server/runtime-state/postgres/runtime-state-conditional.ts',
                statements: ['insert:runtime_state_store']
            },
            {
                id: 'packages/shared-server/runtime-state/postgres/runtime-state-guarded-batch.ts',
                statements: ['update:runtime_state_store']
            }
        ]);
    });

    it('records a schema table written or locked under a schema-qualified or double-quoted name', () => {
        const facts = computeFixtureFacts({
            'packages/shared-server/rallar-system/websocket/on-ws-display-frame.ts': `
                import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
                export async function onWsDisplayFrame(sql: PSqlSql, key: string): Promise<void> {
                    await sql\`insert into public.runtime_state_store (store_key) values (\${key})\`;
                    await sql\`delete from "runtime_state_store" where store_key = \${key}\`;
                    await sql\`update "public"."app_data_store" as stored set value = '{}' where key = \${key}\`;
                    await sql\`select id from resource_inbox for update of "resource_inbox"\`;
                }
            `
        });

        expect(facts.sqlWriteFiles).toEqual([{
            id: 'packages/shared-server/rallar-system/websocket/on-ws-display-frame.ts',
            statements: [
                'delete:runtime_state_store',
                'insert:runtime_state_store',
                'lock:resource_inbox',
                'update:app_data_store'
            ]
        }]);
    });

    it('ignores a select, prose naming no table, and a write tagged on a tx parameter', () => {
        const facts = computeFixtureFacts({
            'packages/shared-server/topology/read-topology.ts': `
                import type { PSqlSql } from '../postgres/p-sql-sql.ts';
                export const NOTE = 'insert into the ledger only after review, then update it set by set';
                export async function readTopology(sql: PSqlSql): Promise<void> { await sql\`select * from resource_inbox\`; }
                export async function writeTopology(tx: PSqlSql): Promise<void> { await tx\`delete from resource_inbox\`; }
            `
        });

        expect(facts).toEqual({ sqlWriteFiles: [], nonTransactionHandleFeeds: [] });
    });

    it('records a root handle fed to a transaction parameter or a holder class, and not a transaction-rooted one', () => {
        const facts = computeFixtureFacts({
            'packages/shared-server/queuebox/postgres/resource-inbox-reservation-write.ts': `
                import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
                export async function writeReservationFinish(transaction: PSqlSql, key: string): Promise<void> {
                    await transaction\`delete from resource_inbox where key = \${key}\`;
                }
            `,
            'packages/shared-server/app-data/p-sql-app-data-repository.ts': `
                import type { PSqlSql } from '../postgres/p-sql-sql.ts';
                export class PSqlAppDataRepository {
                    constructor(private readonly sql: PSqlSql) {}
                    async remove(key: string): Promise<void> { await this.sql\`delete from app_data_store where key = \${key}\`; }
                }
            `,
            'packages/shared-server/app-outbox/install-durable-deadline.ts': `
                import type { PSqlSql } from '../postgres/p-sql-sql.ts';
                import { writeReservationFinish } from '../queuebox/postgres/resource-inbox-reservation-write.ts';
                import { PSqlAppDataRepository } from '../app-data/p-sql-app-data-repository.ts';
                export async function installDurableDeadline(input: { readonly database: PSqlSql }): Promise<void> {
                    await writeReservationFinish(input.database, 'deadline');
                }
                export function createDefaultAppData(sql: PSqlSql): PSqlAppDataRepository {
                    return new PSqlAppDataRepository(sql);
                }
                export async function settle(transaction: PSqlSql): Promise<void> {
                    await writeReservationFinish(transaction, 'settled');
                }
                export async function settleNested(input: { readonly transaction: PSqlSql }): Promise<void> {
                    await writeReservationFinish(input.transaction, 'nested');
                }
                export async function settleInOwnTransaction(sql: PSqlSql): Promise<void> {
                    await sql.begin(async (opened) => writeReservationFinish(opened, 'opened'));
                }
            `
        });

        expect(facts.nonTransactionHandleFeeds).toEqual([
            { id: 'packages/shared-server/app-outbox/install-durable-deadline.ts#createDefaultAppData', count: 1 },
            { id: 'packages/shared-server/app-outbox/install-durable-deadline.ts#installDurableDeadline', count: 1 }
        ]);
    });

    it('follows a root handle through code that feeds it into a write, hop by hop, to a fixed point', () => {
        const facts = computeFixtureFacts({
            'packages/shared-server/app-data/p-sql-app-data-repository.ts': `
                import type { PSqlSql } from '../postgres/p-sql-sql.ts';
                export class PSqlAppDataRepository {
                    constructor(private readonly sql: PSqlSql) {}
                    async remove(key: string): Promise<void> { await this.sql\`delete from app_data_store where key = \${key}\`; }
                }
            `,
            'packages/shared-server/app-data/create-app-data-repository.ts': `
                import type { PSqlSql } from '../postgres/p-sql-sql.ts';
                import { PSqlAppDataRepository } from './p-sql-app-data-repository.ts';
                export function createAppDataRepository(sql: PSqlSql): PSqlAppDataRepository {
                    return new PSqlAppDataRepository(sql);
                }
            `,
            'packages/shared-server/app-data/create-app-data-runtime.ts': `
                import type { PSqlSql } from '../postgres/p-sql-sql.ts';
                import { createAppDataRepository } from './create-app-data-repository.ts';
                export function createAppDataRuntime(database: PSqlSql): unknown {
                    return createAppDataRepository(database);
                }
            `,
            'packages/shared-server/rallar-system/websocket/ws-display-frame-handler.ts': `
                import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
                import { createAppDataRuntime } from '../../app-data/create-app-data-runtime.ts';
                import { createAppDataRepository } from '../../app-data/create-app-data-repository.ts';
                export class WsDisplayFrameHandler {
                    constructor(private readonly sql: PSqlSql) {}
                    onOpen(): unknown { return createAppDataRuntime(this.sql); }
                    onFrame(): Promise<unknown> {
                        return this.sql.begin(async (transaction) => createAppDataRepository(transaction));
                    }
                }
            `
        });

        expect(facts.nonTransactionHandleFeeds).toEqual([
            { id: 'packages/shared-server/app-data/create-app-data-repository.ts#createAppDataRepository', count: 1 },
            { id: 'packages/shared-server/app-data/create-app-data-runtime.ts#createAppDataRuntime', count: 1 },
            {
                id: 'packages/shared-server/rallar-system/websocket/ws-display-frame-handler.ts#WsDisplayFrameHandler.onOpen',
                count: 1
            }
        ]);
    });
});

function computeFixtureFacts(sources: Readonly<Record<string, string>>) {
    const { project, scope } = createDirectWriteFixture({ ...BASE_SOURCES, ...sources });
    return computeSqlWriteFacts(project, scope);
}
