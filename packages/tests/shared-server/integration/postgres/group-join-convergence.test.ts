import {
    describe,
    expect,
    it
} from 'vitest';

import { requireGroupMutationReceipt } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-result-codec.ts';
import { ResourceInboxLostReservationError } from '@shared/queuebox/queue-box-types.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import { readDirectResourceOutboxEntries } from '../../rallar-system/app-outbox/direct-resource-outbox-lifecycle.ts';
import { assertWorkerOutboxLifecycle } from '../../rallar-system/app-outbox/postgres/worker-outbox-lifecycle-assertions.ts';
import {
    createRuntimeStatePostgresSql,
    requirePostgresDatabaseUrl,
    type PostgresSql
} from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';
import { cleanupRuntimeState } from './presence/presence-expiry-concurrency-test-runtime.ts';
import { createPostgresTestRequestIdFactory } from './test-support/create-postgres-test-request-id-factory.ts';
import {
    createPostgresAppInboxWorkerRuntime,
    createPostgresAppInboxWorkerTrace,
    type PostgresAppInboxWorkerRuntime
} from './test-support/postgres-app-inbox-worker-runtime.ts';
import { unwrapAppInboxResult } from './test-support/postgres-group-app-inbox-mutation.ts';
import {
    deleteApplicationQueueRows,
    enqueueGroupFormationCommand,
    readAppInboxRowState,
    readGroupFormationReceipt,
    requireDefined,
    seedGroupFormation,
    toConnectCommand,
    toJoinCommand,
    toPresenceSessionId,
    toRemoveMemberCommand,
    type GroupFormationCommand,
    type GroupFormationCommandResult,
    type GroupFormationFixture
} from './test-support/postgres-group-formation-fixture.ts';
import { createWorkerHold, type WorkerHold } from './test-support/postgres-worker-hold.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;
const requestIdFor = createPostgresTestRequestIdFactory();

interface ConvergenceServer {
    readonly runtime: PostgresAppInboxWorkerRuntime;
    readonly hold: WorkerHold;
}

interface ConvergenceCluster {
    readonly setupSql: PostgresSql;
    readonly fixture: GroupFormationFixture;
    readonly servers: readonly ConvergenceServer[];
}

interface HeldCommand {
    readonly command: GroupFormationCommand;
    /** Settles once any server completes the command. */
    readonly result: Promise<GroupFormationCommandResult>;
    /** The holding server's passes, which end once its held pass returns after the command settles. */
    readonly served: Promise<GroupFormationCommandResult>;
}

// Each command runs on its own server, whose in-process exclusion keys never see the others: only the guards order them.
describe('Postgres group join convergence across AppInbox servers', () => {
    postgresIt('converges two joins and a presence connect that all read the same group revision', async () => {
        await withConvergenceCluster(3, async ({ setupSql, fixture, servers }) => {
            const [firstServer, secondServer, connectServer] = [0, 1, 2].map((index) => serverAt(servers, index));
            const before = requireDefined(await fixture.repository.readSnapshot(fixture.groupRef), 'seeded group').group;
            const firstJoin = await holdCommand(
                setupSql,
                firstServer,
                toJoinCommand({ runtime: firstServer.runtime, fixture, principalId: 'dave', requestId: requestIdFor('converge-join-dave') })
            );
            const secondJoin = await holdCommand(
                setupSql,
                secondServer,
                toJoinCommand({ runtime: secondServer.runtime, fixture, principalId: 'erin', requestId: requestIdFor('converge-join-erin') })
            );
            const connect = await holdCommand(
                setupSql,
                connectServer,
                toConnectCommand({ runtime: connectServer.runtime, fixture, principalId: 'bob', requestId: requestIdFor('converge-connect-bob') })
            );

            firstServer.hold.release();
            unwrapAppInboxResult(await firstJoin.served);
            secondServer.hold.release();
            connectServer.hold.release();
            const [secondOutcome, connectOutcome] = (await Promise.all([secondJoin.served, connect.served])).map(unwrapAppInboxResult);

            const after = requireDefined(await fixture.repository.readSnapshot(fixture.groupRef), 'converged group').group;
            expect(after).toMatchObject({
                snapshotVersion: before.snapshotVersion + 2,
                rosterVersion: before.rosterVersion + 2,
                activeMemberCount: before.activeMemberCount + 2
            });
            const events = (await fixture.repository.listEvents(fixture.groupRef)).filter((event) => event.snapshotVersion >= before.snapshotVersion);
            expect(
                events.filter((event) => event.eventType === 'member-joined' && event.snapshotVersion > before.snapshotVersion).map((event) => ({
                    requestId: event.requestId,
                    snapshotVersion: event.snapshotVersion,
                    payload: event.payload
                }))
            ).toEqual([
                { requestId: firstJoin.command.enqueue.resourceId, snapshotVersion: before.snapshotVersion + 1, payload: { principalId: 'dave' } },
                { requestId: secondJoin.command.enqueue.resourceId, snapshotVersion: before.snapshotVersion + 2, payload: { principalId: 'erin' } }
            ]);

            const [firstReceipt, secondReceipt, connectReceipt] = await Promise.all(
                [firstJoin, secondJoin, connect].map(async (held) => await readGroupFormationReceipt(fixture, held.command))
            );
            expect([firstReceipt, secondReceipt, connectReceipt].map((receipt) => ({ outcome: receipt.outcome, attemptCount: receipt.attemptCount })))
                .toEqual([{ outcome: 'applied', attemptCount: 1 }, { outcome: 'applied', attemptCount: 2 }, { outcome: 'applied', attemptCount: 1 }]);
            expect(requireGroupMutationReceipt(connectOutcome)).toEqual(connectReceipt);
            // The connect read the group before either join committed and guards no group row, so its event and receipt
            // carry the group version it read.
            const connectEvent = requireDefined(events.find((event) => event.requestId === connect.command.enqueue.resourceId), 'connect event');
            expect(connectEvent.snapshotVersion).toBe(connectReceipt.snapshotVersion);
            expect(connectReceipt.snapshotVersion).toBe(before.snapshotVersion);
            const admission = await fixture.repository.findPresenceAdmissionEntry({ ...fixture.groupRef, principalId: 'bob' });
            expect(admission?.value.admittedSessions.map((session) => session.sessionId)).toEqual([toPresenceSessionId('bob')]);

            expect(await Promise.all([firstJoin, secondJoin, connect].map(async (held) => await readAppInboxRowState(setupSql, held.command.queueKey))))
                .toEqual([1, 2, 1].map((attempts) => ({ status: EntityStatus.COMPLETED, attempts, hasResult: true })));
            const receipts = [firstReceipt, secondReceipt, connectReceipt];
            assertWorkerOutboxLifecycle({
                entries: await readDirectResourceOutboxEntries(setupSql, receipts.flatMap((receipt) => receipt.outboxIds)),
                outputs: receipts.map((receipt) => ({ outboxIds: receipt.outboxIds, domainStatus: receipt.outcome })),
                kind: 'group',
                effects: ['group-presence-summary']
            });

            const eventCount = (await fixture.repository.listEvents(fixture.groupRef)).length;
            const replayed = unwrapAppInboxResult(
                await secondServer.runtime.runUntilCompletion(() =>
                    secondServer.runtime.group.processAuthenticatedGroupEntryUntilCompletion(secondJoin.command.enqueue, secondJoin.command.input.authority)
                )
            );
            expect(replayed).toEqual(secondOutcome);
            expect(await fixture.repository.listEvents(fixture.groupRef)).toHaveLength(eventCount);
            expect(await readAppInboxRowState(setupSql, secondJoin.command.queueKey)).toMatchObject({ attempts: 2 });
        });
    }, 90_000);

    postgresIt('rolls back a join whose lease lapsed mid-compute once another server has committed it', async () => {
        await withConvergenceCluster(2, async ({ setupSql, fixture, servers }) => {
            const [staleServer, recoveringServer] = [0, 1].map((index) => serverAt(servers, index));
            const before = requireDefined(await fixture.repository.readSnapshot(fixture.groupRef), 'seeded group').group;
            const join = await holdCommand(
                setupSql,
                staleServer,
                toJoinCommand({ runtime: staleServer.runtime, fixture, principalId: 'dave', requestId: requestIdFor('lapsed-join-dave') })
            );

            await lapseLease(setupSql, join.command);
            const recovered = unwrapAppInboxResult(await recoveringServer.runtime.dequeueUntilSettled(join.result));
            staleServer.hold.release();
            // The stale write conflicts on the group row the recovered attempt advanced and rolls back; its release then
            // finds the reservation gone and ends that server's pass instead of overwriting the completed row.
            await expect(join.served).rejects.toBeInstanceOf(ResourceInboxLostReservationError);
            expect(unwrapAppInboxResult(await join.result)).toEqual(recovered);

            const after = requireDefined(await fixture.repository.readSnapshot(fixture.groupRef), 'joined group').group;
            expect(after).toMatchObject({
                snapshotVersion: before.snapshotVersion + 1,
                rosterVersion: before.rosterVersion + 1,
                activeMemberCount: before.activeMemberCount + 1
            });
            const joined = (await fixture.repository.listEvents(fixture.groupRef))
                .filter((event) => event.eventType === 'member-joined' && event.snapshotVersion > before.snapshotVersion);
            expect(joined.map((event) => event.requestId)).toEqual([join.command.enqueue.resourceId]);
            expect(await readGroupFormationReceipt(fixture, join.command)).toMatchObject({
                outcome: 'applied',
                attemptCount: 2,
                snapshotVersion: before.snapshotVersion + 1
            });
            expect(await readAppInboxRowState(setupSql, join.command.queueKey)).toEqual({ status: EntityStatus.COMPLETED, attempts: 2, hasResult: true });
        });
    }, 90_000);

    postgresIt.each(['removal', 'connect'] as const)(
        'never leaves a presence session admitted for a removed member, when the %s commits first',
        async (firstToCommit) => {
            await withConvergenceCluster(2, async ({ setupSql, fixture, servers }) => {
                const [removeServer, connectServer] = [0, 1].map((index) => serverAt(servers, index));
                const removal = await holdCommand(
                    setupSql,
                    removeServer,
                    toRemoveMemberCommand({
                        runtime: removeServer.runtime,
                        fixture,
                        principalId: 'bob',
                        requestId: requestIdFor(`race-remove-${firstToCommit}`)
                    })
                );
                const connect = await holdCommand(
                    setupSql,
                    connectServer,
                    toConnectCommand({ runtime: connectServer.runtime, fixture, principalId: 'bob', requestId: requestIdFor(`race-connect-${firstToCommit}`) })
                );
                const [first, second] = firstToCommit === 'removal'
                    ? [{ server: removeServer, held: removal }, { server: connectServer, held: connect }]
                    : [{ server: connectServer, held: connect }, { server: removeServer, held: removal }];

                first.server.hold.release();
                unwrapAppInboxResult(await first.held.served);
                second.server.hold.release();
                const [removalResult, connectResult] = await Promise.all([removal.served, connect.served]);

                expect(unwrapAppInboxResult(removalResult)).toBeDefined();
                expect(connectResult.fold(() => 'not-applied', (result) => requireGroupMutationReceipt(result).outcome))
                    .toBe(firstToCommit === 'removal' ? 'not-applied' : 'applied');
                const snapshot = requireDefined(await fixture.repository.readSnapshot(fixture.groupRef), 'group');
                expect(snapshot.members.find((member) => member.principalId === 'bob')?.status).toBe('removed');
                const admission = await fixture.repository.findPresenceAdmissionEntry({ ...fixture.groupRef, principalId: 'bob' });
                expect(admission?.value.admittedSessions ?? []).toEqual([]);
                expect(snapshot.activeSessions.filter((session) => session.principalId === 'bob')).toEqual([]);
            });
        },
        90_000
    );
});

async function withConvergenceCluster(serverCount: number, run: (cluster: ConvergenceCluster) => Promise<void>): Promise<void> {
    const databaseUrl = requirePostgresDatabaseUrl();
    const setupSql = await createRuntimeStatePostgresSql(databaseUrl, 2);
    const serverSqls = await Promise.all(Array.from({ length: serverCount }, async () => await createRuntimeStatePostgresSql(databaseUrl, 4)));
    const scope = { applicationId: `group-join-convergence-${crypto.randomUUID()}`, workspaceId: 'workspace-1' };
    const holds = serverSqls.map(() => createWorkerHold());
    try {
        const fixture = await seedGroupFormation({ sql: setupSql, scope, activeMemberIds: ['bob', 'carol'], atEpochMs: Date.now(), requestIdFor });
        const servers = serverSqls.map((sql, index) => {
            const hold = requireDefined(holds[index], 'server hold');
            const runtime = createPostgresAppInboxWorkerRuntime({
                sql,
                serviceId: `convergence-server-${index}`,
                atEpochMs: fixture.atEpochMs + 1_000,
                beforeMutationTransaction: hold.arrive,
                trace: createPostgresAppInboxWorkerTrace()
            });
            return { runtime, hold };
        });
        await run({ setupSql, fixture, servers });
    }
    finally {
        holds.forEach((hold) => hold.release());
        await cleanupRuntimeState(setupSql, scope.applicationId);
        await deleteApplicationQueueRows(setupSql, scope.applicationId);
        await Promise.all([setupSql.end(), ...serverSqls.map((sql) => sql.end())]);
    }
}

/** Queues the command, lets only this server claim it, and resolves once the server holds it after its compute. */
async function holdCommand(setupSql: PostgresSql, server: ConvergenceServer, command: GroupFormationCommand): Promise<HeldCommand> {
    server.runtime.armBarrier();
    const { result } = await enqueueGroupFormationCommand(setupSql, command);
    const served = server.runtime.dequeueUntilSettled(result);
    served.catch(() => undefined);
    await server.hold.arrived;
    expect(await readAppInboxRowState(setupSql, command.queueKey)).toMatchObject({ status: EntityStatus.RESERVED, attempts: 1 });
    return { command, result, served };
}

/** Moves the claim's start past every reserved-entry timeout, as if its server had stalled that long. */
async function lapseLease(sql: PostgresSql, command: GroupFormationCommand): Promise<void> {
    const { topicId, resourceId, contextId } = command.queueKey;
    await sql`
        update resource_inbox
        set start_ts = start_ts - interval '1 hour'
        where ri_topic_id = ${topicId} and ri_resource_id = ${resourceId} and fk_ext_bank_id = ${contextId}
    `;
}

function serverAt(servers: readonly ConvergenceServer[], index: number): ConvergenceServer {
    return requireDefined(servers[index], `convergence server ${index}`);
}
