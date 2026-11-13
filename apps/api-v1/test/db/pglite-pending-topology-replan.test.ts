import { test } from 'bun:test';
import assert from 'node:assert/strict';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import {
    createPSqlResourceInboxRepository,
    type PSqlResourceInboxRepository
} from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import {
    COALESCED_APP_OUTBOX_WORK_FIELD,
    tryReadCoalescedAppOutboxWorkEnvelope,
    writeCoalescedAppOutboxWork,
    type ComputedCoalescedAppOutboxWork
} from '@shared-server/rallar-system/app-outbox/coalesced-app-outbox-work.ts';
import {
    computeCoalescedRtcTopologyGroupRevisionWork,
    readPendingTopologyReplan
} from '@shared-server/rallar-system/topology/replay/work/rtc-topology-coalesced-group-revision-work.ts';
import {
    computeRtcTopologyReservationFinish,
    finishRtcTopologyReservation
} from '@shared-server/rallar-system/topology/replay/work/rtc-topology-work-completion.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { withPGliteSql } from './pglite-auth-test-harness.ts';
import { topologyGroupSnapshotWithSessionIds } from './pglite-topology-test-runtime.ts';

const GROUP_REF: GroupRef = { applicationId: 'pending-replan', workspaceId: 'transactions', groupId: 'parked-successor' };

// A replan written while the head executes parks on a successor row; the head's own completion leaves that row queued.
test('the pending replan read reports a successor parked behind a head that has since completed', async () => {
    await withPGliteSql(async (sql) => {
        const repository = createPSqlResourceInboxRepository(sql, () => new Date());
        const { head, reserved, parked } = await writeSuccessorBehindReservedHead(sql, repository);
        await finishReservation(sql, reserved);

        assert.equal((await repository.entries.findByKey(head.entryWrite.entry.key))?.status, EntityStatus.COMPLETED);
        const parkedWork = tryReadCoalescedAppOutboxWorkEnvelope(parked.successorWrite.entry)?.data[
            COALESCED_APP_OUTBOX_WORK_FIELD
        ];
        assert.ok(parkedWork);
        assert.deepEqual(await readPendingTopologyReplan(repository.entries, GROUP_REF), {
            reconfigureQueued: true,
            dueAtEpochMs: parkedWork.dueAtEpochMs,
            generation: parkedWork.generation
        });
    });
});

test('the pending replan read reports nothing once the parked successor has completed too', async () => {
    await withPGliteSql(async (sql) => {
        const repository = createPSqlResourceInboxRepository(sql, () => new Date());
        const { reserved, parked } = await writeSuccessorBehindReservedHead(sql, repository);
        await finishReservation(sql, reserved);
        const successor = (await repository.reservations.startProcessingEntity(parked.successorWrite.entry)).right;
        assert.ok(successor);
        await finishReservation(sql, successor);

        assert.equal(await readPendingTopologyReplan(repository.entries, GROUP_REF), null);
    });
});

async function writeSuccessorBehindReservedHead(
    sql: PSqlSql,
    repository: PSqlResourceInboxRepository
): Promise<{ head: ComputedCoalescedAppOutboxWork; reserved: ResourceEntry; parked: ComputedCoalescedAppOutboxWork; }> {
    const head = computePendingRevisionWork(null);
    assert.equal(await sql.begin((transaction) => writeCoalescedAppOutboxWork(transaction, head)), 'written');
    const reserved = (await repository.reservations.startProcessingEntity(head.entryWrite.entry)).right;
    assert.ok(reserved);
    const parked = computePendingRevisionWork(reserved);
    assert.equal(parked.operation, 'write-successor');
    assert.equal(await sql.begin((transaction) => writeCoalescedAppOutboxWork(transaction, parked)), 'written');
    return { head, reserved, parked };
}

async function finishReservation(sql: PSqlSql, reserved: ResourceEntry): Promise<void> {
    const finish = computeRtcTopologyReservationFinish(reserved, new Date());
    await sql.begin((transaction) => finishRtcTopologyReservation(transaction, finish));
}

function computePendingRevisionWork(previousEntry: ResourceEntry | null): ComputedCoalescedAppOutboxWork {
    const requestedAtEpochMs = Date.now();
    return computeCoalescedRtcTopologyGroupRevisionWork({
        traceId: 'trace-pglite-pending-topology-replan',
        aggregateRef: GROUP_REF,
        groupSnapshot: topologyGroupSnapshotWithSessionIds(GROUP_REF, ['session-a'], requestedAtEpochMs),
        requestedAtEpochMs,
        expireAtEpochMs: requestedAtEpochMs + 60_000,
        timing: { window: { debounceMs: 250, maxWaitMs: 1_000 }, replanNotBeforeEpochMs: null, expectedMembersArrived: false },
        senderId: 'rallar-server',
        origin: 'automatic',
        previousEntry
    });
}
