import { Temporal } from '@js-temporal/polyfill';
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
    onTestFinished
} from 'vitest';

import { createDefaultPSqlALInboundRuntimeStores } from '@shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';
import { PSqlResourceInboxMaintenance } from '@shared-server/queuebox/postgres/resource-inbox-maintenance.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { newALBroadcastMessage, newALRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeALPeerControlMessage } from '@shared/al-contracts/al-control.ts';
import { AL_FIRST_GAP_RENEWAL_REQUEST_NUMBER } from '@shared/al-contracts/al-message-resource-limits.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { toALInboundMessageReference } from '@shared/alm/inbound/al-inbound-canonical-message.ts';
import type { ALInboundMessageRuntime, ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { toALInboundWorkKey } from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { createDefaultALInboundMessageRuntime } from '@shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import { toALInboundGapRenewalEffectId } from '@shared/alm/inbound/gap-renewal/compute-al-inbound-gap-renewal.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { EntityStatus, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import {
    createRuntimeStatePostgresSql,
    requirePostgresDatabaseUrl,
    type PostgresSql
} from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';
import {
    deletePostgresRunRows,
    NO_POSTGRES_RUN_ROWS,
    readPostgresRunRowCounts
} from './test-support/delete-postgres-run-rows.ts';
import { waitUntil } from './test-support/wait-until.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;
const RUN_ID = `al-inbound-gap-renewal-${crypto.randomUUID()}`;
/** The server's inbound owner, as `WsQueueBoxServerService` composes it. */
const SERVER_PEER_ID = 'server';
const ROOM: GroupRef = { applicationId: `app-${RUN_ID}`, workspaceId: 'workspace', groupId: 'room' };
const SCOPED_WS_SOURCE: ALInboundMessageRuntime.Source = {
    kind: 'ws-client',
    peerId: 'sender',
    authenticatedScope: { applicationId: ROOM.applicationId, workspaceId: ROOM.workspaceId }
};

describe('Postgres inbound gap renewal', () => {
    let sql: PostgresSql | undefined;

    beforeAll(async () => {
        if (process.env.RALLAR_POSTGRES_INTEGRATION === '1') {
            sql = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
        }
    });

    afterAll(async () => {
        if (sql !== undefined) {
            try {
                await deletePostgresRunRows(sql, RUN_ID);
                expect(await readPostgresRunRowCounts(sql, RUN_ID)).toEqual(NO_POSTGRES_RUN_ROWS);
            }
            finally {
                await sql.end();
            }
        }
    });

    // The queue judges a row due by the database's clock, so this runs on the wall clock, with no fake timers.
    postgresIt('writes the gap timer due later, claims it when due, and ends it when the gap closes', async () => {
        const stores = createStores(requireSql(sql), 'renewal');
        const controls: ALMessage[] = [];
        const runtime = createRuntime(stores, controls);
        const second = createMessage('second', 2, 30_000);
        const beforeMs = Date.now();
        await runtime.admitIncomingMessage(second, SCOPED_WS_SOURCE);
        const afterMs = Date.now();
        const timer = await readTimerRow(stores, second, 2);
        expect(timer.status).toBe(EntityStatus.NEW);
        expect(timer.dequeueAudit.nextTs!.epochMilliseconds).toBeGreaterThanOrEqual(beforeMs + 1_000);
        expect(timer.dequeueAudit.nextTs!.epochMilliseconds).toBeLessThanOrEqual(afterMs + 1_000);
        await waitUntil(beforeMs + 900);
        expect((await readTimerRow(stores, second, 2)).status).toBe(EntityStatus.NEW);
        expect(readRenewalNumbers(controls)).toEqual([]);
        await expect.poll(() => readRenewalNumbers(controls), { timeout: 5_000 }).toEqual([2, 2]);
        expect((await readTimerRow(stores, second, 2)).status).toBe(EntityStatus.COMPLETED);
        expect((await readTimerRow(stores, second, 3)).status).toBe(EntityStatus.NEW);
        await runtime.admitIncomingMessage(createMessage('first', 1, 30_000), SCOPED_WS_SOURCE);
        await expect.poll(async () => (await readTimerRow(stores, second, 3)).status, { timeout: 5_000 })
            .toBe(EntityStatus.COMPLETED);
        expect(readRenewalNumbers(controls)).toEqual([2, 2]);
    });

    postgresIt('never claims a timer that expires before it is due, and the expiry sweep removes it', async () => {
        const database = requireSql(sql);
        const stores = createStores(database, 'expiry');
        const controls: ALMessage[] = [];
        const runtime = createRuntime(stores, controls);
        const second = createMessage('second', 2, 500);
        const beforeMs = Date.now();
        await runtime.admitIncomingMessage(second, SCOPED_WS_SOURCE);
        expect((await readTimerRow(stores, second, 2)).status).toBe(EntityStatus.NEW);
        await waitUntil(beforeMs + 1_100);
        // The store reads no expired row, so what is left of the timer is read from its table.
        expect(await readStoredTimerStatuses(database, toTimerKey(stores, second, 2))).toEqual([EntityStatus.NEW]);
        expect(readRenewalNumbers(controls)).toEqual([]);
        await new PSqlResourceInboxMaintenance(database).deleteExpired();
        expect(await readStoredTimerStatuses(database, toTimerKey(stores, second, 2))).toEqual([]);
    });
});

function requireSql(sql: PostgresSql | undefined): PostgresSql {
    if (sql === undefined) {
        throw new Error('The PostgreSQL client was not opened');
    }
    return sql;
}

/** The server's PostgreSQL inbound pair, in a namespace of this run. */
function createStores(sql: PostgresSql, name: string): ALInboundRuntimeStores {
    return createDefaultPSqlALInboundRuntimeStores({
        namespace: `${RUN_ID}-${name}`,
        repository: new PSqlRuntimeStateRepository(sql)
    });
}

/** The server's inbound owner: it orders every track it admits, and its renewal stretch is drawn as 1. */
function createRuntime(stores: ALInboundRuntimeStores, controls: ALMessage[]): ALInboundMessageRuntime {
    const runtime = createDefaultALInboundMessageRuntime({
        receiptProofs: { kind: 'carrier-authenticated' },
        orderingObserver: 'every-track',
        carrier: 'ws',
        selfPeerId: SERVER_PEER_ID,
        stores,
        random: () => 0,
        planIncomingMessage: (message, source, observations) =>
            planALMessageHandling(message, {
                selfPeerId: SERVER_PEER_ID,
                fromPeerId: source.kind === 'trusted-server' ? message.id.senderId : source.peerId,
                ...observations
            }),
        toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox', Temporal.Now.instant()),
        dispatchInboxEntry: async () => {},
        sendControlMessages: async (messages) => {
            controls.push(...messages);
        },
        diagnostics: undefined
    });
    onTestFinished(() => runtime.dispose());
    return runtime;
}

/** A WS client's ordered room send at `seq`, at least once, ack none. */
function createMessage(name: string, seq: number, ttlMs: number): ALMessage {
    const message = newALBroadcastMessage({
        createdAtEpochMs: Date.now(),
        senderId: 'sender',
        route: newALRoute('room.stream', ROOM.groupId, name),
        scope: 'room',
        typeId: 'stream.message.v1',
        resource: { name },
        options: { groupRef: ROOM, ttlMs, reliability: 'at-least-once', ack: 'none', ordering: { orderingKey: 'stream' } }
    });
    return { ...message, ordering: { orderingKey: 'stream', seq } };
}

/** The key of the timer `revealing` armed for sequence 1, numbered `requestNumber`: only the fields its id names count. */
function toTimerKey(stores: ALInboundRuntimeStores, revealing: ALMessage, requestNumber: number): Key {
    return toALInboundWorkKey(
        stores.admissionStore.namespace,
        toALInboundGapRenewalEffectId({
            kind: 'renew-gap',
            trackKey: toALOrderingTrackKey(revealing)!,
            range: { from: 1, to: 1 },
            requestNumber,
            toPeerId: 'sender',
            message: toALInboundMessageReference(revealing),
            traceId: revealing.id.traceId,
            signsForRecipient: false
        })
    );
}

async function readTimerRow(
    stores: ALInboundRuntimeStores,
    revealing: ALMessage,
    requestNumber: number
): Promise<ResourceEntry> {
    const row = await stores.workQueue.getItem(toTimerKey(stores, revealing, requestNumber));
    if (row === undefined || row === null) {
        throw new Error(`No timer numbered ${requestNumber} is stored`);
    }
    return row;
}

/** The status of each row stored under `key`, expired or not. */
async function readStoredTimerStatuses(sql: PostgresSql, key: Key): Promise<readonly string[]> {
    const rows = await sql<{ ri_status: string; }[]>`
        select ri_status from resource_inbox
        where ri_topic_id = ${key.topicId} and ri_resource_id = ${key.resourceId} and fk_ext_bank_id = ${key.contextId}
    `;
    return rows.map((row) => row.ri_status);
}

/** The number of every renewal the runtime sent, NACK and repair request alike, in send order. */
function readRenewalNumbers(controls: readonly ALMessage[]): readonly number[] {
    return controls.flatMap((message) => {
        const control = decodeALPeerControlMessage(message).right;
        const number = control?.type === 'nack' || control?.type === 'repair' ? control.payload.gapRequestNumber : undefined;
        return number !== undefined && number >= AL_FIRST_GAP_RENEWAL_REQUEST_NUMBER ? [number] : [];
    });
}
