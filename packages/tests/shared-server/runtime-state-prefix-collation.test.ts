import { PSqlAdminOperationsStatsReader } from '@shared-server/postgres/admin-operations/PSqlAdminOperationsStatsReader.ts';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { describe, expect, it } from 'vitest';

describe('Postgres runtime-state prefix collation', () => {
    it('uses bytewise ordering for prefix reads', async () => {
        const captured = captureQueries();
        const repository = new PSqlRuntimeStateRepository(captured.sql);

        await repository.findEntriesByPrefix(
            'group-state:members',
            'app=app:ws=workspace:group=room:'
        );

        expect(captured.queries).toHaveLength(1);
        expect(captured.queries[0]).toContain('store_key collate "C" >=');
        expect(captured.queries[0]).toContain('store_key collate "C" <');
        expect(captured.queries[0]).toContain('order by store_key collate "C"');
    });

    it('uses bytewise ordering for paged prefix reads', async () => {
        const captured = captureQueries();
        const repository = new PSqlRuntimeStateRepository(captured.sql);

        await repository.findEntriesByPrefixPage(
            'group-state:members',
            'app=app:ws=workspace:group=room:',
            { afterKey: 'app=app:ws=workspace:group=room:member=alice', limit: 10 }
        );

        expect(captured.queries).toHaveLength(1);
        expect(captured.queries[0]).toContain('store_key collate "C" >=');
        expect(captured.queries[0]).toContain('store_key collate "C" <');
        expect(captured.queries[0]).toContain('store_key collate "C" >');
        expect(captured.queries[0]).toContain('order by store_key collate "C"');
    });

    it('uses bytewise ordering and cursors when paging an entire namespace', async () => {
        const captured = captureQueries();
        const repository = new PSqlRuntimeStateRepository(captured.sql);

        await repository.findEntriesByPrefixPage('group-state:members', '', { limit: 10 });
        await repository.findEntriesByPrefixPage('group-state:members', '', {
            afterKey: 'app=app:ws=workspace:group=room:member=alice',
            limit: 10
        });

        expect(captured.queries).toHaveLength(2);
        expect(captured.queries[0]).toContain('order by store_key collate "C"');
        expect(captured.queries[1]).toContain('store_key collate "C" >');
        expect(captured.queries[1]).toContain('order by store_key collate "C"');
    });

    it('uses bytewise ordering for scoped admin runtime-state reads', async () => {
        const captured = captureQueries();
        const reader = new PSqlAdminOperationsStatsReader(captured.sql, { now: () => 1_000 });

        await reader.readState({
            adminSession: {
                clientId: 'admin',
                username: 'admin',
                accessToken: 'token',
                sessionId: 'session',
                expiresAtEpochMs: 2_000
            },
            scope: { applicationId: 'app', workspaceId: 'workspace' }
        });

        const prefixQueries = captured.queries.filter((query) => query.includes('select store_key, store_value from runtime_state_store'));
        expect(prefixQueries).toHaveLength(5);
        for (const query of prefixQueries) {
            expect(query).toContain('store_key collate "C" >=');
            expect(query).toContain('store_key collate "C" <');
            expect(query).toContain('order by store_key collate "C"');
        }
    });
});

function captureQueries(): Readonly<{ sql: PSqlSql; queries: string[]; }> {
    const queries: string[] = [];
    const sql = (async (
        strings: TemplateStringsArray,
        ..._values: unknown[]
    ): Promise<unknown> => {
        queries.push(Array.from(strings).join('?').replaceAll(/\s+/g, ' ').trim());
        return [];
    }) as PSqlSql;
    sql.begin = async <T>(fn: (transaction: PSqlSql) => Promise<T>): Promise<T> => await fn(sql);
    return { sql, queries };
}
