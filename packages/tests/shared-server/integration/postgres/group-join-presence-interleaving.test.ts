import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { requireGroupMutationReceipt } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-result-codec.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import { createRuntimeStatePostgresSql, requirePostgresDatabaseUrl } from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';
import { cleanupRuntimeState } from './presence/presence-expiry-concurrency-test-runtime.ts';
import { createPostgresTestRequestIdFactory } from './test-support/create-postgres-test-request-id-factory.ts';
import { createPostgresAppInboxWorkerRuntime, createPostgresAppInboxWorkerTrace } from './test-support/postgres-app-inbox-worker-runtime.ts';
import { unwrapAppInboxResult } from './test-support/postgres-group-app-inbox-mutation.ts';
import {
    deleteGroupFormationQueueRows,
    enqueueGroupFormationCommand,
    readAppInboxRowState,
    readGroupFormationReceipt,
    requireFormationValue,
    seedGroupFormation,
    toConnectCommand,
    toJoinCommand,
    toPresenceSessionId,
    type GroupFormationCommandResult
} from './test-support/postgres-group-formation-fixture.ts';
import { lockGroupRow, type GroupRowLock } from './test-support/postgres-group-row-lock.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;
const requestIdFor = createPostgresTestRequestIdFactory();

describe('Postgres group joins and presence in one AppInbox lane', () => {
    postgresIt('commits other members\' presence connects while a join waits on the group row, and keeps joins in claim order', async () => {
        const databaseUrl = requirePostgresDatabaseUrl();
        const setupSql = await createRuntimeStatePostgresSql(databaseUrl, 2);
        const workerSql = await createRuntimeStatePostgresSql(databaseUrl, 8);
        const lockSql = await createRuntimeStatePostgresSql(databaseUrl);
        const scope = { applicationId: `group-join-presence-interleaving-${crypto.randomUUID()}`, workspaceId: 'workspace-1' };
        let lock: GroupRowLock | undefined;
        let settled: Promise<readonly GroupFormationCommandResult[]> | undefined;

        try {
            const fixture = await seedGroupFormation({ sql: setupSql, scope, activeMemberIds: ['bob', 'carol'], atEpochMs: Date.now(), requestIdFor });
            const trace = createPostgresAppInboxWorkerTrace();
            const runtime = createPostgresAppInboxWorkerRuntime({
                sql: workerSql,
                serviceId: 'interleaving-server',
                atEpochMs: fixture.atEpochMs + 1_000,
                newLaneConcurrency: 4,
                trace
            });
            const commandInput = { runtime, fixture };
            const commands = [
                toJoinCommand({ ...commandInput, principalId: 'dave', requestId: requestIdFor('interleaving-join-dave') }),
                toJoinCommand({ ...commandInput, principalId: 'erin', requestId: requestIdFor('interleaving-join-erin') }),
                toConnectCommand({ ...commandInput, principalId: 'bob', requestId: requestIdFor('interleaving-connect-bob') }),
                toConnectCommand({ ...commandInput, principalId: 'carol', requestId: requestIdFor('interleaving-connect-carol') })
            ] as const;
            const [firstJoin, secondJoin, bobConnect, carolConnect] = commands;
            const before = requireFormationValue(await fixture.repository.readSnapshot(fixture.groupRef), 'seeded group').group;

            const results: Promise<GroupFormationCommandResult>[] = [];
            for (const command of commands) {
                results.push((await enqueueGroupFormationCommand(setupSql, command)).result);
            }
            lock = await lockGroupRow({ lockSql, observerSql: setupSql, groupRef: fixture.groupRef });
            settled = runtime.dequeueUntilSettled(Promise.all(results));
            settled.catch(() => undefined);
            await lock.waitForBlockedWriter();

            await vi.waitFor(async () => {
                for (const connect of [bobConnect, carolConnect]) {
                    expect(await readAppInboxRowState(setupSql, connect.queueKey)).toMatchObject({ status: EntityStatus.COMPLETED, hasResult: true });
                }
            }, { timeout: 10_000, interval: 20 });
            expect(await readAppInboxRowState(setupSql, firstJoin.queueKey)).toMatchObject({ status: EntityStatus.RESERVED, hasResult: false });
            expect(await readAppInboxRowState(setupSql, secondJoin.queueKey)).toMatchObject({ hasResult: false });

            await lock.release();
            const outcomes = (await settled).map(unwrapAppInboxResult);

            const after = requireFormationValue(await fixture.repository.readSnapshot(fixture.groupRef), 'joined group').group;
            expect(after).toMatchObject({
                snapshotVersion: before.snapshotVersion + 2,
                rosterVersion: before.rosterVersion + 2,
                activeMemberCount: before.activeMemberCount + 2
            });
            const joinedEvents = (await fixture.repository.listEvents(fixture.groupRef))
                .filter((event) => event.eventType === 'member-joined' && event.snapshotVersion > before.snapshotVersion)
                .map((event) => ({ requestId: event.requestId, snapshotVersion: event.snapshotVersion }));
            expect(joinedEvents).toEqual([
                { requestId: firstJoin.enqueue.resourceId, snapshotVersion: before.snapshotVersion + 1 },
                { requestId: secondJoin.enqueue.resourceId, snapshotVersion: before.snapshotVersion + 2 }
            ]);

            const receipts = await Promise.all(commands.map(async (command) => await readGroupFormationReceipt(fixture, command)));
            expect(receipts.map((receipt) => ({ outcome: receipt.outcome, attemptCount: receipt.attemptCount })))
                .toEqual(commands.map(() => ({ outcome: 'applied', attemptCount: 1 })));
            expect(outcomes.slice(2).map((outcome) => requireGroupMutationReceipt(outcome).attemptCount)).toEqual([1, 1]);
            for (const command of commands) {
                expect(await readAppInboxRowState(setupSql, command.queueKey)).toEqual({ status: EntityStatus.COMPLETED, attempts: 1, hasResult: true });
            }
            const commandResourceIds = commands.map((command) => command.queueKey.resourceId);
            expect(trace.attempts.filter((attempt) => commandResourceIds.includes(attempt.resourceId)).map((attempt) => attempt.attempt))
                .toEqual([1, 1, 1, 1]);
            for (const principalId of ['bob', 'carol']) {
                const admission = await fixture.repository.findPresenceAdmissionEntry({ ...fixture.groupRef, principalId });
                expect(admission?.value.admittedSessions.map((session) => session.sessionId)).toEqual([toPresenceSessionId(principalId)]);
            }
        }
        finally {
            await lock?.release();
            await settled?.catch(() => undefined);
            await cleanupRuntimeState(setupSql, scope.applicationId);
            await deleteGroupFormationQueueRows(setupSql, scope.applicationId);
            await Promise.all([setupSql.end(), workerSql.end(), lockSql.end()]);
        }
    }, 60_000);
});
