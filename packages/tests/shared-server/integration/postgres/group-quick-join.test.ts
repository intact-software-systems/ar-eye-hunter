import { describe, expect, it } from 'vitest';

import { decodePersistedAppInboxEnqueue } from '@shared-server/rallar-system/app-inbox/app-inbox-command-decoding.ts';
import { writeAppOutboxInsert } from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { GroupLifecyclePolicyRepository } from '@shared-server/rallar-system/group-state/persistence/group-lifecycle-policy-repository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { createTestGroupStateRuntime } from '../../rallar-system/group-state/group-state-test-runtime.ts';
import {
    createRuntimeStatePostgresSql,
    requirePostgresDatabaseUrl,
    type PostgresSql
} from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';
import { deletePostgresRunRows } from './test-support/delete-postgres-run-rows.ts';
import {
    createPostgresAppInboxWorkerRuntime,
    createPostgresAppInboxWorkerTrace,
    type PostgresAppInboxWorkerRuntime
} from './test-support/postgres-app-inbox-worker-runtime.ts';
import { createPostgresAppInboxTestAuthority, unwrapAppInboxResult } from './test-support/postgres-group-app-inbox-mutation.ts';
import { createWorkerHold, type WorkerHold } from './test-support/postgres-worker-hold.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

interface QuickJoinServer {
    readonly sql: PostgresSql;
    readonly runtime: PostgresAppInboxWorkerRuntime;
    readonly hold: WorkerHold;
    readonly authority: IssuedAuthSession;
}

interface QuickJoinCluster {
    readonly scope: StateScope;
    readonly repository: GroupStateRepository;
    readonly first: QuickJoinServer;
    readonly second: QuickJoinServer;
}

describe('Postgres Quick Join contention', () => {
    postgresIt.each(['policy', 'session'] as const)('rereads changed %s after losing the group guard', async (changed) => {
        await withQuickJoinCluster(true, async ({ scope, repository, first, second }) => {
            first.runtime.armBarrier();
            const winner = first.runtime.runUntilCompletion(() =>
                first.runtime.group.processQuickJoinUntilCompletion({
                    scope,
                    request: { requestId: `${scope.applicationId}:winner`, includeEmpty: true }
                }, first.authority)
            );
            await first.hold.arrived;
            second.runtime.armBarrier();
            const loser = second.runtime.runUntilCompletion(() =>
                second.runtime.group.processQuickJoinUntilCompletion({
                    scope,
                    request: { requestId: `${scope.applicationId}:fresh-read`, includeEmpty: true }
                }, second.authority)
            );
            await second.hold.arrived;
            first.hold.release();
            unwrapAppInboxResult(await winner);
            if (changed === 'session') {
                await second.runtime.authSessions.deleteSession(second.authority);
            }
            else {
                const policies = new GroupLifecyclePolicyRepository(new PSqlRuntimeStateRepository(first.sql));
                const ref = { ...scope, groupId: 'b-fallback' };
                const policy = await policies.readPolicy(ref);
                if (policy.status !== 'present') {
                    throw new Error('Expected fallback admission policy');
                }
                await policies.writePolicy(ref, { ...policy.policy, admission: { ...policy.policy.admission, mode: 'closed' } });
            }

            second.hold.release();
            const outcome = await loser;

            if (changed === 'session') {
                expect(outcome.left).toMatchObject({ status: 403 });
            }
            else {
                expect(outcome.right).toEqual({ status: 'unavailable' });
            }
            expect((await repository.readSnapshot({ ...scope, groupId: 'b-fallback' }))?.group.activeMemberCount).toBe(1);
        });
    }, 45_000);

    postgresIt('rolls back membership, event and receipt when its final outbox collides', async () => {
        await withQuickJoinCluster(false, async ({ scope, repository, first }) => {
            const ref = { ...scope, groupId: 'a-last-seat' };
            const before = await repository.readSnapshot(ref);
            const requestId = `${scope.applicationId}:collision`;
            first.runtime.armBarrier();
            const pending = first.runtime.runUntilCompletion(() =>
                first.runtime.group.processQuickJoinUntilCompletion({
                    scope,
                    request: { requestId, includeEmpty: true }
                }, first.authority)
            );
            await first.hold.arrived;
            const entry = await readQuickJoinEntry(first, requestId);
            const service = first.runtime.group.groupStateService.quickJoin;
            const computed = service.compute(
                await service.read(decodePersistedAppInboxEnqueue(entry).authority, { attemptCount: 1, traceId: 'trace-group-quick-join' })
            );
            if (computed.mutation === null || computed.mutation.outboxWrites.length === 0) {
                throw new Error('Expected a selected membership write and final outbox');
            }
            const outbox = computed.mutation.outboxWrites[0];
            await first.sql.begin(async (transaction) => await writeAppOutboxInsert(transaction, outbox));

            first.hold.release();
            const outcome = await pending;

            expect(outcome.left).toBeDefined();
            expect(outcome.right).toBeUndefined();
            expect(await repository.readSnapshot(ref)).toEqual(before);
            expect((await repository.listEvents(ref)).filter((event) => event.requestId === requestId)).toEqual([]);
            expect(await repository.findIdempotentGroupMutationReceipt(ref, computed.mutation.receipt.commandId)).toBeUndefined();
            const result = await first.runtime.resourceInboxResults.findByKey(entry.key);
            expect(result?.status).toBe('FAILED');
            expect(result?.resource).not.toContain('"status":"joined"');
            expect(await first.runtime.resourceInbox.entries.findByKey(outbox.entry.key)).not.toBeNull();
        });
    }, 45_000);

    postgresIt('durably exhausts attempt 20 after a last-seat revision conflict without admitting', async () => {
        await withQuickJoinCluster(false, async ({ scope, repository, first }) => {
            const requestId = `${scope.applicationId}:exhausted`;
            const input = { scope, request: { requestId, includeEmpty: true } };
            const pending = first.runtime.group.processQuickJoinUntilCompletion(input, first.authority);
            await expect.poll(async () =>
                (await first.sql<{ count: number; }[]>`
                select count(*)::int as count from resource_inbox where ri_resource_id = ${requestId}
            `)[0]?.count
            ).toBe(1);
            await first.sql`
                update resource_inbox set ri_status = 'RETRY', ri_attempts = 19,
                    start_ts = now() - interval '3 seconds', end_ts = now() - interval '2 seconds',
                    next_ts = now() - interval '1 second'
                where ri_resource_id = ${requestId}
            `;
            first.runtime.armBarrier();
            const served = first.runtime.dequeueUntilSettled(pending);
            await first.hold.arrived;
            const ref = { ...scope, groupId: 'a-last-seat' };
            const before = await repository.readSnapshot(ref);
            if (!before) {
                throw new Error('Expected the selected room');
            }
            await repository.putGroup({ ...before.group, displayName: 'Concurrently renamed' });

            first.hold.release();
            const outcome = await served;

            expect(outcome.left).toMatchObject({ code: 'app-inbox-retry-exhausted', status: 503, retry: { attempts: 20 } });
            expect((await repository.readSnapshot(ref))?.group.activeMemberCount).toBe(1);
            expect((await repository.listEvents(ref)).filter((event) => event.requestId === requestId)).toEqual([]);
            const replay = await first.runtime.group.processQuickJoinUntilCompletion(input, first.authority);
            expect(replay.left).toEqual(outcome.left);
        });
    }, 45_000);

    postgresIt.each([false, true])('rereads after a last-seat conflict, with fallback=%s', async (fallback) => {
        await withQuickJoinCluster(fallback, async ({ scope, repository, first, second }) => {
            first.runtime.armBarrier();
            const firstResult = first.runtime.runUntilCompletion(() =>
                first.runtime.group.processQuickJoinUntilCompletion({
                    scope,
                    request: { requestId: `${scope.applicationId}:first`, includeEmpty: true }
                }, first.authority)
            );
            await first.hold.arrived;
            second.runtime.armBarrier();
            const secondInput = { scope, request: { requestId: `${scope.applicationId}:second`, includeEmpty: true } };
            const secondResult = second.runtime.runUntilCompletion(() => second.runtime.group.processQuickJoinUntilCompletion(secondInput, second.authority));
            await second.hold.arrived;

            first.hold.release();
            expect(unwrapAppInboxResult(await firstResult)).toMatchObject({
                status: 'joined',
                snapshot: { group: { groupId: 'a-last-seat', activeMemberCount: 2 } }
            });
            second.hold.release();
            const outcome = unwrapAppInboxResult(await secondResult);

            expect(outcome).toMatchObject(
                fallback
                    ? { status: 'joined', snapshot: { group: { groupId: 'b-fallback', activeMemberCount: 2 } } }
                    : { status: 'unavailable' }
            );
            const original = await repository.readSnapshot({ ...scope, groupId: 'a-last-seat' });
            expect(original?.group.activeMemberCount).toBe(2);
            expect(original?.members.map((member) => member.principalId).sort()).toEqual([`${scope.applicationId}:owner`, first.authority.clientId].sort());
            const joinedEvents = (await repository.listEvents({ ...scope, groupId: 'a-last-seat' }))
                .filter((event) => event.eventType === 'member-joined');
            expect(joinedEvents.map((event) => event.requestId)).toEqual([`${scope.applicationId}:first`]);
            const [queue] = await second.sql<{ ri_attempts: number; ri_status: string; }[]>`
                select ri_attempts::int, ri_status from resource_inbox where ri_resource_id = ${secondInput.request.requestId}
            `;
            expect(queue).toEqual({ ri_attempts: 2, ri_status: 'COMPLETED' });
            const replay = await second.runtime.group.processQuickJoinUntilCompletion(secondInput, second.authority);
            expect(unwrapAppInboxResult(replay)).toEqual(outcome);
        });
    }, 45_000);
});

async function readQuickJoinEntry(server: QuickJoinServer, requestId: string): Promise<ResourceEntry> {
    const [key] = await server.sql<Key[]>`
        select ri_topic_id as "topicId", ri_resource_id as "resourceId", fk_ext_bank_id as "contextId"
        from resource_inbox where ri_resource_id = ${requestId}
    `;
    const entry = key ? await server.runtime.resourceInbox.entries.findByKey(key) : null;
    if (!entry) {
        throw new Error('Expected a persisted Quick Join entry');
    }
    return entry;
}

async function withQuickJoinCluster(fallback: boolean, run: (cluster: QuickJoinCluster) => Promise<void>): Promise<void> {
    const scope = { applicationId: `quick-join-${crypto.randomUUID()}`, workspaceId: 'workspace' };
    const first = await createQuickJoinServer(scope, 'first');
    const second = await createQuickJoinServer(scope, 'second');
    try {
        const repository = await seedQuickJoinRooms(first.sql, scope, fallback);
        await run({ scope, repository, first, second });
    }
    finally {
        first.hold.release();
        second.hold.release();
        await deletePostgresRunRows(first.sql, scope.applicationId);
        await Promise.all([first.sql.end(), second.sql.end()]);
    }
}

async function createQuickJoinServer(scope: StateScope, name: string): Promise<QuickJoinServer> {
    const sql = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl(), 4);
    const hold = createWorkerHold();
    const runtime = createPostgresAppInboxWorkerRuntime({
        sql,
        serviceId: `quick-join-${name}`,
        atEpochMs: Date.now(),
        newLaneHeldRows: undefined,
        beforeMutationTransaction: hold.arrive,
        trace: createPostgresAppInboxWorkerTrace()
    });
    const authority = createPostgresAppInboxTestAuthority(`${scope.applicationId}:${name}`, `${scope.applicationId}:${name}-session`);
    await runtime.authSessions.putSession(authority);
    return { sql, runtime, hold, authority };
}

async function seedQuickJoinRooms(sql: PostgresSql, scope: StateScope, fallback: boolean): Promise<GroupStateRepository> {
    const runtimeRepository = new PSqlRuntimeStateRepository(sql);
    const events = new PSqlGroupStateEventRepository(sql);
    const setup = createTestGroupStateRuntime({
        runtimeRepository,
        groupStateEventStoreFor: () => events,
        serviceId: 'quick-join-setup'
    }).service;
    for (const groupId of fallback ? ['a-last-seat', 'b-fallback'] : ['a-last-seat']) {
        await setup.createGroup(scope, {
            groupId,
            displayName: 'AR Eye Hunter',
            kind: 'room',
            joinMode: 'open',
            maxMembers: 2,
            createdByPrincipalId: `${scope.applicationId}:owner`,
            requestId: `${scope.applicationId}:create-${groupId}`
        });
    }
    return new GroupStateRepository(runtimeRepository, events);
}
