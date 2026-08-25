import { describe, expect, it } from 'vitest';

import { PSqlAdminStateReader } from '@shared-server/rallar-system/admin-operations/postgres/p-sql-admin-state-reader.ts';
import { clientStateWorkspaceStorageKey } from '@shared-server/rallar-system/client-state/persistence/client-state-storage-keys.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { AuditStamp, Group, GroupMember, GroupPresenceSession, GroupRef } from '@shared/api/group-types.ts';
import { createTestGroup } from '../../../create-test-group.ts';

import { createRuntimeStatePostgresSql, type PostgresSql } from '../../postgres-runtime-state-client-fixtures.ts';

const POSTGRES_INTEGRATION_ENABLED = readEnv('RALLAR_POSTGRES_INTEGRATION') === '1';
const postgresIt = POSTGRES_INTEGRATION_ENABLED ? it : it.skip;
const FUTURE_MS = Date.parse('9999-12-31T23:59:59.999Z');

type ExplainRow = Readonly<{
    'QUERY PLAN': string;
}>;

type GlobalEnv = Readonly<{
    Deno?: Readonly<{
        env: Readonly<{
            get(key: string): string | undefined;
        }>;
    }>;
    process?: Readonly<{
        env?: Readonly<Record<string, string | undefined>>;
    }>;
}>;

describe('Postgres runtime-state prefix selection', () => {
    postgresIt('matches hierarchical child keys literally under the database collation', async () => {
        const sql = await createSql(requireDatabaseUrl());
        const repository = new PSqlRuntimeStateRepository(sql);
        const namespace = `runtime-prefix-${crypto.randomUUID()}`;
        const parentPrefix = 'app=rallar-server:ws=default:group=room-1:';
        const firstChildKey = `${parentPrefix}member=alice`;
        const secondChildKey = `${parentPrefix}member=bob`;
        const siblingKey = 'app=rallar-server:ws=default:group=room-10:member=bob';

        try {
            await repository.upsert(namespace, firstChildKey, '{"member":"alice"}', FUTURE_MS);
            await repository.upsert(namespace, secondChildKey, '{"member":"bob"}', FUTURE_MS);
            await repository.upsert(namespace, siblingKey, '{"member":"bob"}', FUTURE_MS);

            const entries = await repository.findEntriesByPrefix(namespace, parentPrefix);
            const firstPage = await repository.findEntriesByPrefixPage(
                namespace,
                parentPrefix,
                { limit: 1 }
            );
            const secondPage = await repository.findEntriesByPrefixPage(
                namespace,
                parentPrefix,
                { afterKey: firstChildKey, limit: 1 }
            );

            expect(entries.map((entry) => entry.key)).toEqual([
                firstChildKey,
                secondChildKey
            ]);
            for (const entry of entries) {
                expect(entry.updatedTimestamp).toMatch(
                    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
                );
            }
            expect(firstPage.map((entry) => entry.key)).toEqual([firstChildKey]);
            expect(secondPage.map((entry) => entry.key)).toEqual([secondChildKey]);
        }
        finally {
            await sql`
                delete from runtime_state_store
                where store_namespace = ${namespace}
            `;
            await sql.end();
        }
    });

    postgresIt('uses the composite C-collated index for selective prefix ranges', async () => {
        const sql = await createSql(requireDatabaseUrl());
        const namespace = `runtime-prefix-plan-${crypto.randomUUID()}`;
        const prefix = 'app=ops:';
        const prefixEnd = 'app=ops;';

        try {
            const indexes = await sql<ReadonlyArray<{ indexdef: string; }>>`
        select indexdef
        from pg_indexes
        where schemaname = 'public'
          and indexname = 'runtime_state_store_namespace_key_c_ix'
      `;
            expect(indexes).toHaveLength(1);
            expect(indexes[0].indexdef).toContain(
                '(store_namespace, store_key COLLATE "C")'
            );

            await sql`
        insert into runtime_state_store (
          store_namespace,
          store_key,
          store_value,
          expire_at_ts
        )
        select ${namespace},
               case
                 when n <= 10 then ${prefix} || lpad(n::text, 5, '0')
                 else 'other:' || lpad(n::text, 5, '0')
               end,
               '{}',
               now() + interval '1 hour'
        from generate_series(1, 10000) as series(n)
      `;
            await sql`analyze runtime_state_store`;
            await sql`set enable_seqscan = off`;
            await sql`set enable_bitmapscan = off`;

            const plan = await sql<ExplainRow[]>`
        explain (costs off)
        select store_key, store_value, updated_ts, expire_at_ts, store_namespace, revision
        from runtime_state_store
        where store_namespace = ${namespace}
          and store_key collate "C" >= ${prefix}
          and store_key collate "C" < ${prefixEnd}
        order by store_key collate "C"
      `;

            expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toContain(
                'Index Scan using runtime_state_store_namespace_key_c_ix'
            );
        }
        finally {
            await sql`
        delete from runtime_state_store
        where store_namespace = ${namespace}
      `;
            await sql.end();
        }
    });

    postgresIt('reports scoped runtime state under the database collation', async () => {
        const sql = await createSql(requireDatabaseUrl());
        const repository = new PSqlRuntimeStateRepository(sql);
        const applicationId = `runtime-prefix-admin-${crypto.randomUUID()}`;
        const workspaceId = 'default';
        const scopePrefix = `app=${applicationId}:ws=${workspaceId}:`;
        const nowEpochMs = Date.now();
        const liveSessionExpiry = nowEpochMs + 60_000;

        try {
            await repository.upsert(
                'client-state:principals',
                `${scopePrefix}principal=alice`,
                JSON.stringify({ applicationId, workspaceId, principalId: 'alice' }),
                FUTURE_MS
            );
            await repository.upsert(
                'client-state:sessions',
                `${scopePrefix}principal=alice:instance=browser:session=alice-session`,
                JSON.stringify({
                    applicationId,
                    workspaceId,
                    principalId: 'alice',
                    clientInstanceId: 'browser',
                    sessionId: 'alice-session',
                    status: 'active',
                    expiresAtEpochMs: liveSessionExpiry
                }),
                FUTURE_MS
            );
            await repository.upsert(
                'group-state:groups',
                `${scopePrefix}group=room-1`,
                JSON.stringify(groupFixture({ applicationId, workspaceId, groupId: 'room-1' })),
                FUTURE_MS
            );
            await repository.upsert(
                'group-state:members',
                `${scopePrefix}group=room-1:member=alice`,
                JSON.stringify(
                    activeMemberFixture({ applicationId, workspaceId, groupId: 'room-1' }, 'alice')
                ),
                FUTURE_MS
            );
            await repository.upsert(
                'group-state:sessions',
                `${scopePrefix}group=room-1:session=alice-session`,
                JSON.stringify(
                    activePresenceFixture(
                        { applicationId, workspaceId, groupId: 'room-1' },
                        'alice',
                        'alice-session',
                        liveSessionExpiry
                    )
                ),
                FUTURE_MS
            );

            const state = await new PSqlAdminStateReader(sql, {
                nowEpochMs: () => nowEpochMs
            }).execute({
                adminSession: {
                    clientId: 'platform-admin',
                    username: 'admin',
                    accessToken: 'access-token',
                    sessionId: 'admin-session',
                    expiresAtEpochMs: liveSessionExpiry
                },
                scope: { applicationId, workspaceId }
            });

            expect(state.clients).toEqual({
                totalPrincipals: 1,
                onlinePrincipals: 1,
                activeSessions: 1
            });
            expect(state.groups).toEqual({
                activeGroups: 1,
                totalActiveMembers: 1,
                onlineMembers: 1
            });
        }
        finally {
            await sql`
                delete from runtime_state_store
                where left(store_key, char_length(${scopePrefix})) = ${scopePrefix}
            `;
            await sql.end();
        }
    });

    postgresIt('isolates lookalike client-state workspace prefixes', async () => {
        const sql = await createSql(requireDatabaseUrl());
        const repository = new PSqlRuntimeStateRepository(sql);
        const namespace = `runtime-workspace-isolation-${crypto.randomUUID()}`;
        const applicationId = `runtime-workspace-app-${crypto.randomUUID()}`;
        const workspaceCases = [
            { workspaceId: '_', workspaceKey: '_' },
            { workspaceId: '%5F', workspaceKey: '%255F' },
            { workspaceId: 'a:b', workspaceKey: 'a%3Ab' },
            { workspaceId: 'a%3Ab', workspaceKey: 'a%253Ab' }
        ] as const;

        try {
            for (const { workspaceId, workspaceKey } of workspaceCases) {
                expect(clientStateWorkspaceStorageKey(workspaceId)).toBe(workspaceKey);
                const scopePrefix = `app=${applicationId}:ws=${workspaceKey}:`;
                await repository.upsert(
                    namespace,
                    `${scopePrefix}principal=shared-principal`,
                    JSON.stringify({ applicationId, workspaceId, principalId: 'shared-principal' }),
                    FUTURE_MS
                );
            }

            for (const { workspaceId, workspaceKey } of workspaceCases) {
                const scopePrefix = `app=${applicationId}:ws=${workspaceKey}:`;
                const entries = await repository.findEntriesByPrefix(namespace, scopePrefix);

                expect(entries).toHaveLength(1);
                expect(JSON.parse(entries[0]?.value ?? '{}')).toEqual({
                    applicationId,
                    workspaceId,
                    principalId: 'shared-principal'
                });
            }
        }
        finally {
            await sql`
        delete from runtime_state_store
        where store_namespace = ${namespace}
      `;
            await sql.end();
        }
    });
});

function groupFixture(ref: GroupRef): Group {
    const audit = auditStamp();
    return createTestGroup({
        ...ref,
        displayName: ref.groupId,
        activeMemberCount: 1,
        ownerPrincipalId: 'alice',
        snapshotVersion: 1,
        metadataVersion: 1,
        rosterVersion: 1,
        presenceVersion: 1,
        created: audit,
        updated: audit
    });
}

function activeMemberFixture(ref: GroupRef, principalId: string): GroupMember {
    const audit = auditStamp();
    return {
        ...ref,
        principalId,
        role: 'owner',
        status: 'active',
        joined: audit,
        updated: audit,
        left: null,
        removed: null,
        banned: null,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null
    };
}

function activePresenceFixture(
    ref: GroupRef,
    principalId: string,
    sessionId: string,
    expiresAtEpochMs: number
): GroupPresenceSession {
    const connectedAtEpochMs = expiresAtEpochMs - 60_000;
    return {
        ...ref,
        principalId,
        sessionId,
        generationId: `${sessionId}-generation`,
        generationVersion: connectedAtEpochMs,
        connectedAtEpochMs,
        lastHeartbeatAtEpochMs: connectedAtEpochMs,
        expiresAtEpochMs,
        disconnectedAtEpochMs: null,
        disconnectReason: null,
        status: 'active'
    };
}

function auditStamp(): AuditStamp {
    return {
        atEpochMs: 1,
        actor: { kind: 'service', serviceId: 'runtime-prefix-integration-test' },
        reason: null,
        traceId: null,
        requestId: null
    };
}

async function createSql(databaseUrl: string): Promise<PostgresSql> {
    return await createRuntimeStatePostgresSql(databaseUrl);
}

function requireDatabaseUrl(): string {
    const databaseUrl = readEnv('DATABASE_URL');
    if (!databaseUrl) {
        throw new Error('DATABASE_URL is required when RALLAR_POSTGRES_INTEGRATION=1');
    }
    return databaseUrl;
}

function readEnv(name: string): string | undefined {
    const globals = globalThis as GlobalEnv;
    return globals.Deno?.env.get(name) ?? globals.process?.env?.[name];
}
