import type { PSqlParameter, PSqlRows, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { readGroupStateSnapshotVersions } from '@shared-server/rallar-system/group-state/persistence/read-group-state-authority.ts';
import { InMemoryClientStateEventStore } from '@shared-server/rallar-system/state-events/in-memory-client-state-event-store.ts';
import { InMemoryGroupStateEventStore } from '@shared-server/rallar-system/state-events/in-memory-group-state-event-store.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type {
    RuntimeStateReadBatchSelection,
    RuntimeStateReadBatchSelector
} from '@shared-server/runtime-state/read-batch/runtime-state-read-batch.ts';
import type { ClientInstance, ClientPrincipal, ClientPrincipalRef, ClientSession } from '@shared/api/client-types.ts';
import type { AuditStamp, GroupMember, GroupPresenceSession, GroupRef } from '@shared/api/group-types.ts';
import { describe, expect, it } from 'vitest';

import { createTestGroup } from '../../../create-test-group.ts';
import { createRuntimeStatePostgresSql, type PostgresSql } from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';
import { deletePostgresRunRows } from './test-support/delete-postgres-run-rows.ts';

const POSTGRES_INTEGRATION_ENABLED = readEnv('RALLAR_POSTGRES_INTEGRATION') === '1';
const postgresIt = POSTGRES_INTEGRATION_ENABLED ? it : it.skip;
const SESSION_EXPIRES_AT_EPOCH_MS = 4_000_000_000_000;
const HOUR_MS = 60 * 60 * 1000;
const SESSIONS_NAMESPACE = 'group-state:sessions';

class PresenceRowCountingRuntime extends PSqlRuntimeStateRepository {
    presenceRows = 0;

    override async readRuntimeStateBatch(selectors: readonly RuntimeStateReadBatchSelector[]) {
        const selections = await super.readRuntimeStateBatch(selectors);
        this.presenceRows += countPresenceRows(selectors, selections);
        return selections;
    }

    override async readRuntimeStateBatchWithVersion(selectors: readonly RuntimeStateReadBatchSelector[]) {
        const batch = await super.readRuntimeStateBatchWithVersion(selectors);
        this.presenceRows += countPresenceRows(selectors, batch.selections);
        return batch;
    }

    takePresenceRows(): number {
        const rows = this.presenceRows;
        this.presenceRows = 0;
        return rows;
    }
}

describe('Postgres reads of live history rows', () => {
    postgresIt('reads a co-member\'s one connected session, not its 40 disconnected ones, in the same single statement', async () => {
        await withRun(async ({ sql, scope }) => {
            const bob: ClientPrincipalRef = { ...scope, principalId: 'bob' };
            await seedClient(new ClientStateRepository(new PSqlRuntimeStateRepository(sql), new InMemoryClientStateEventStore()), bob);
            const driverRowCounts: number[] = [];
            const clients = new ClientStateRepository(
                new PSqlRuntimeStateRepository(observeDriverRowCounts(sql, driverRowCounts)),
                new InMemoryClientStateEventStore()
            );

            const audience = await clients.readAudienceSessionsForPrincipals([bob]);

            expect(audience.map((entry) => entry.activeSessions.map(({ sessionId }) => sessionId))).toEqual([['bob-open']]);
            expect(driverRowCounts).toEqual([2]);
        });
    });

    postgresIt('still reads every own session, so a disconnected target session and an expired one stay visible to the fence', async () => {
        await withRun(async ({ sql, scope }) => {
            const bob: ClientPrincipalRef = { ...scope, principalId: 'bob' };
            const clients = new ClientStateRepository(new PSqlRuntimeStateRepository(sql), new InMemoryClientStateEventStore());
            await seedClient(clients, bob);
            await clients.insertSession(
                disconnected(session(bob, 'bob-lapsed', 1_000))
            );

            const closed = await clients.readMutationState(ownRead(bob, 'bob-closed-07'));
            const lapsed = await clients.readMutationState(ownRead(bob, 'bob-lapsed'));

            expect(closed.session.value?.value).toMatchObject({ sessionId: 'bob-closed-07', status: 'disconnected' });
            expect(closed.principalSnapshot?.snapshot.activeSessions.map(({ sessionId }) => sessionId)).toEqual(['bob-open']);
            expect(lapsed.session.value).toBeUndefined();
            expect(lapsed.session.expiredEntry?.key).toContain('session=bob-lapsed');
        });
    });

    postgresIt('leaves presence rows whose lease has ended out of snapshot reads and in the mutation read', async () => {
        await withRun(async ({ sql, scope }) => {
            const runtime = new PresenceRowCountingRuntime(sql);
            const groups = new GroupStateRepository(runtime, new InMemoryGroupStateEventStore());
            const ref: GroupRef = { ...scope, groupId: 'room' };
            const nowEpochMs = Date.now();
            const live = presenceSession(ref, 'live', nowEpochMs + HOUR_MS);
            await seedGroup(groups, ref, live);
            await groups.putPresenceSession(presenceSession(ref, 'ended', nowEpochMs - HOUR_MS));
            await groups.putPresenceSession(presenceSession(ref, 'ended-earlier', nowEpochMs - 23 * HOUR_MS));
            runtime.takePresenceRows();

            const versioned = await groups.readVersionedSnapshot(runtime, ref, nowEpochMs);
            expect(versioned.snapshot?.activeSessions.map(({ sessionId }) => sessionId)).toEqual(['live']);
            expect(runtime.takePresenceRows()).toBe(1);
            await expect(readGroupStateSnapshotVersions(runtime, [ref], nowEpochMs)).resolves.toEqual([
                versioned.version?.version
            ]);

            expect((await groups.listSnapshots(scope)).map((snapshot) => snapshot.activeSessions.length)).toEqual([1]);
            expect(runtime.takePresenceRows()).toBe(1);
            expect((await groups.listSnapshotsPage(scope, { limit: 10 })).snapshots[0]?.activeSessions.length).toBe(1);
            expect(runtime.takePresenceRows()).toBe(1);

            const mutationRead = await groups.readMutationExactEntries({
                aggregateRef: ref,
                includeGroup: true,
                includePresenceSummary: true,
                includeLifecyclePolicy: false,
                includeGroupSnapshot: true,
                authSessionId: null,
                requestIds: [],
                memberPrincipalIds: [],
                presenceSessionIds: [],
                admissionPrincipalIds: []
            });
            expect(mutationRead.status).toBe('stable');
            expect(runtime.takePresenceRows()).toBe(3);
        });
    });

    postgresIt('moves the snapshot version on a presence write, as the probe of the same rows reports it', async () => {
        await withRun(async ({ sql, scope }) => {
            const runtime = new PSqlRuntimeStateRepository(sql);
            const groups = new GroupStateRepository(runtime, new InMemoryGroupStateEventStore());
            const ref: GroupRef = { ...scope, groupId: 'room' };
            const nowEpochMs = Date.now();
            const live = presenceSession(ref, 'live', nowEpochMs + HOUR_MS);
            await seedGroup(groups, ref, live);
            const before = await groups.readVersionedSnapshot(runtime, ref, nowEpochMs);

            await groups.putPresenceSession({ ...live, lastHeartbeatAtEpochMs: 7 });

            const [probed] = await readGroupStateSnapshotVersions(runtime, [ref], nowEpochMs);
            expect(probed).not.toBe(before.version?.version);
            expect((await groups.readVersionedSnapshot(runtime, ref, nowEpochMs)).version?.version).toBe(probed);
        });
    });
});

interface PostgresRun {
    readonly sql: PostgresSql;
    readonly scope: Readonly<{ applicationId: string; workspaceId: string; }>;
}

async function withRun(test: (run: PostgresRun) => Promise<void>): Promise<void> {
    const sql = await createRuntimeStatePostgresSql(requireDatabaseUrl());
    const runId = `live-rows-${crypto.randomUUID()}`;
    try {
        await test({ sql, scope: { applicationId: `app-${runId}`, workspaceId: 'workspace-1' } });
    }
    finally {
        await deletePostgresRunRows(sql, runId);
        await sql.end();
    }
}

async function seedClient(clients: ClientStateRepository, ref: ClientPrincipalRef): Promise<void> {
    await clients.insertPrincipal(principal(ref));
    await clients.insertInstance(instance(ref));
    for (let index = 0; index < 40; index += 1) {
        await clients.insertSession(
            disconnected(session(ref, `bob-closed-${String(index).padStart(2, '0')}`, SESSION_EXPIRES_AT_EPOCH_MS))
        );
    }
    await clients.insertSession(session(ref, 'bob-open', SESSION_EXPIRES_AT_EPOCH_MS));
}

function ownRead(ref: ClientPrincipalRef, sessionId: string) {
    return {
        principalRef: ref,
        instanceRef: null,
        sessionRef: { ...ref, clientInstanceId: 'bob-instance', sessionId },
        requestId: null,
        companionSelectors: []
    };
}

async function seedGroup(groups: GroupStateRepository, ref: GroupRef, live: GroupPresenceSession): Promise<void> {
    await groups.putGroup(createTestGroup({ ...ref, ownerPrincipalId: 'alice', activeMemberCount: 1 }));
    await groups.putMember(owner(ref));
    await groups.putPresenceSession(live);
    await groups.insertPresenceSummary({
        ...ref,
        causalRevision: { groupRevision: 1, presenceRevision: 1 },
        activePrincipalIds: ['alice'],
        activeSessionIds: [live.sessionId],
        activeSessions: [live],
        activePrincipalCount: 1,
        activeSessionCount: 1,
        computedAtEpochMs: 1
    });
}

function principal(ref: ClientPrincipalRef): ClientPrincipal {
    return {
        ...ref,
        username: ref.principalId,
        displayName: ref.principalId,
        avatarUrl: null,
        authProvider: null,
        externalSubjectId: null,
        status: 'active',
        disabled: null,
        deleted: null,
        roles: [],
        metadata: {},
        snapshotVersion: 1,
        profileVersion: 1,
        presenceVersion: 1,
        created: audit(),
        updated: audit(),
        lastSeenAtEpochMs: 1
    };
}

function instance(ref: ClientPrincipalRef): ClientInstance {
    return {
        ...ref,
        clientInstanceId: 'bob-instance',
        status: 'active',
        revoked: null,
        platform: 'web',
        deviceLabel: null,
        appVersion: null,
        userAgent: null,
        capabilities: [],
        registered: audit(),
        updated: audit()
    };
}

function session(ref: ClientPrincipalRef, sessionId: string, expiresAtEpochMs: number): ClientSession {
    return {
        ...ref,
        clientInstanceId: 'bob-instance',
        sessionId,
        generationId: `${sessionId}-generation`,
        generationVersion: 1,
        status: 'active',
        presenceState: 'online',
        transport: 'ws',
        connectionId: null,
        authenticatedAtEpochMs: 1,
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs,
        disconnectedAtEpochMs: null,
        disconnectReason: null
    };
}

function disconnected(value: ClientSession): ClientSession {
    return { ...value, status: 'disconnected', disconnectedAtEpochMs: 2, disconnectReason: 'closed' };
}

function owner(ref: GroupRef): GroupMember {
    return {
        ...ref,
        principalId: 'alice',
        role: 'owner',
        status: 'active',
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
        joined: audit(),
        left: null,
        removed: null,
        banned: null,
        updated: audit()
    };
}

function presenceSession(ref: GroupRef, sessionId: string, expiresAtEpochMs: number): GroupPresenceSession {
    return {
        ...ref,
        principalId: 'alice',
        sessionId,
        generationId: `${sessionId}-generation`,
        connectionGenerationId: `${sessionId}-ws-generation`,
        generationVersion: 1,
        status: 'active',
        disconnectedAtEpochMs: null,
        disconnectReason: null,
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs
    };
}

function audit(): AuditStamp {
    return {
        atEpochMs: 1,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null
    };
}

function countPresenceRows(
    selectors: readonly RuntimeStateReadBatchSelector[],
    selections: readonly RuntimeStateReadBatchSelection[]
): number {
    return selections
        .filter((_selection, index) => selectors[index]?.namespace === SESSIONS_NAMESPACE)
        .reduce((rows, selection) => rows + selection.entries.length, 0);
}

function observeDriverRowCounts(sql: PSqlSql, rowCounts: number[]): PSqlSql {
    const observed = function<Rows extends PSqlRows> (
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ...values: PSqlParameter[]
    ): Promise<Rows> | object {
        if (!Object.hasOwn(stringsOrValues, 'raw')) {
            return sql(stringsOrValues as readonly PSqlParameter[]);
        }
        return Promise.resolve(sql<Rows>(stringsOrValues as TemplateStringsArray, ...values)).then((result) => {
            rowCounts.push(Array.isArray(result) ? result.length : -1);
            return result;
        });
    } as PSqlSql;
    observed.begin = sql.begin.bind(sql);
    return observed;
}

function requireDatabaseUrl(): string {
    const databaseUrl = readEnv('DATABASE_URL');
    if (!databaseUrl) {
        throw new Error('DATABASE_URL is required when RALLAR_POSTGRES_INTEGRATION=1');
    }
    return databaseUrl;
}

function readEnv(name: string): string | undefined {
    const globals = globalThis as Readonly<{
        Deno?: Readonly<{ env: Readonly<{ get(key: string): string | undefined; }>; }>;
        process?: Readonly<{ env?: Readonly<Record<string, string | undefined>>; }>;
    }>;
    return globals.Deno?.env.get(name) ?? globals.process?.env?.[name];
}
