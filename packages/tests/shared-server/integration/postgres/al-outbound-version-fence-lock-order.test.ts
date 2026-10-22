import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import { PSqlAdmissionWorkBackend } from '@shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { createTestALOutboundControlAdmission } from '@shared-test/shared/create-test-al-outbound-work-port.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import {
    createALOutboundAdmissionStore,
    type ALOutboundAdmissionStore,
    type ALOutboundCommitBundle
} from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';

import { createOutboundMessage, readOutboundTestAdmission } from '../../../shared/alm/outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from '../../../shared/alm/outbound-test-payload.ts';
import { createResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

const NAMESPACE = 'fence-lock-order';
const GATE_LOCK_ID = 4242;
const WAIT_POLL = { timeout: 20_000, interval: 25 };

interface WaitingCount {
    readonly waiting: number;
}

describe('Postgres outbound sender version fence lock order', () => {
    // A bundle that rewrites a message's pending acknowledgement fences on the sender version and so locks it first.
    // A control commit for the same message that wrote the version as a key-ordered effect could lock the pending
    // acknowledgement first: each then waited on the other's row, and Postgres aborted one with an untyped deadlock.
    postgresIt('serializes a pending-ack bundle and a late acknowledgement on the sender version as a typed conflict', async () => {
        const storage = await createResourceInboxTestStorage('fence_lock_order', 6);
        try {
            await installRowGate(storage.sql);
            const store = createStore(storage.sql);
            const message = await seedTwoPeerObligation(store);
            const bundle = await readPendingAckBundle(store, message);
            const control = createTestALOutboundControlAdmission({
                admissionStore: store,
                workQueue: store.backend.workQueue,
                nowMs: Date.now,
                carrier: 'ws'
            });

            const gate = holdRowGate(storage.sql);
            await gate.held;
            const committing = settle(store.commitBundle(bundle));
            await expect.poll(() => readWaitingCount(storage.sql), WAIT_POLL).toBe(1);
            const acknowledging = settle(control.admit(toDeliveredAck(message, 'peer-1'), 'peer'));
            await expect.poll(() => readWaitingCount(storage.sql), WAIT_POLL).toBe(2);
            gate.release();
            await gate.closed;

            expect(await committing).toEqual({ status: 'fulfilled', value: 'committed' });
            expect(await acknowledging).toEqual({ status: 'fulfilled', value: { kind: 'pending-control' } });
        }
        finally {
            await storage.close();
        }
    }, 60_000);
});

interface FenceLockOrderStore extends ALOutboundAdmissionStore<OutboundTestPayload> {
    readonly backend: PSqlAdmissionWorkBackend;
}

function createStore(sql: PSqlSql): FenceLockOrderStore {
    const backend = new PSqlAdmissionWorkBackend({ sql, namespace: NAMESPACE, nowMs: Date.now });
    const store = createALOutboundAdmissionStore({
        nowMs: Date.now,
        canonicalScope: NAMESPACE,
        namespace: NAMESPACE,
        decodePrepared: decodeOutboundTestPayload,
        backend,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    return Object.assign(store, { backend });
}

/**
 * Every update of a sender version or pending-ack row waits, with the row already locked, until the gate opens:
 * whichever commit reaches its first such row holds it there.
 */
async function installRowGate(sql: PSqlSql): Promise<void> {
    await sql`
        create function gate_admission_row() returns trigger language plpgsql as $gate$
        begin
            if new.store_key like '%:version:%' or new.store_key like '%:pending-ack:%' then
                perform pg_advisory_xact_lock_shared(4242);
            end if;
            return new;
        end
        $gate$
    `;
    await sql`
        create trigger gate_admission_row before update on runtime_state_store
        for each row execute function gate_admission_row()
    `;
}

interface RowGate {
    readonly held: Promise<void>;
    readonly closed: Promise<void>;
    release(): void;
}

function holdRowGate(sql: PSqlSql): RowGate {
    const { promise: held, resolve: markHeld } = Promise.withResolvers<void>();
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    const closed = sql.begin(async (transaction) => {
        await transaction`select pg_advisory_xact_lock(${GATE_LOCK_ID})`;
        markHeld();
        await released;
    });
    return { held, closed, release: () => release() };
}

async function readWaitingCount(sql: PSqlSql): Promise<number> {
    const [row] = await sql<WaitingCount[]>`
        select count(*)::int as waiting from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()
    `;
    return row?.waiting ?? 0;
}

function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
    return Promise.allSettled([promise]).then(([result]) => result!);
}

/** A committed message two peers owe an acknowledgement for, so one acknowledgement rewrites the pending row. */
async function seedTwoPeerObligation(store: FenceLockOrderStore): Promise<ALMessage> {
    const message = createOutboundMessage('lock-order');
    const admission = await readOutboundTestAdmission({
        store,
        message,
        creationNow: () => Temporal.Now.instant(),
        clock: { nowMs: () => Date.now() }
    });
    expect(await store.commitBundle({ ...admission, mutations: [...admission.mutations, toPendingAck(message, 0)] }))
        .toBe('committed');
    return message;
}

/** A later send of the same sender whose bundle also rewrites the obligation, as a repair re-send does. */
async function readPendingAckBundle(
    store: FenceLockOrderStore,
    message: ALMessage
): Promise<ALOutboundCommitBundle<OutboundTestPayload>> {
    const admission = await readOutboundTestAdmission({
        store,
        message: createOutboundMessage('lock-order-resend'),
        creationNow: () => Temporal.Now.instant(),
        clock: { nowMs: () => Date.now() }
    });
    return { ...admission, mutations: [...admission.mutations, toPendingAck(message, 1)] };
}

function toPendingAck(
    message: ALMessage,
    attempts: number
): ALOutboundCommitBundle<OutboundTestPayload>['mutations'][number] {
    return {
        kind: 'set-pending-ack',
        originPeerId: message.id.senderId,
        snapshot: {
            msgId: message.id.msgId,
            mode: 'hop',
            expectedPeerIds: ['peer-1', 'peer-2'],
            ackedPeerIds: [],
            timeoutMs: 2_000,
            maxAttempts: 3,
            attempts,
            deadlineAtMs: Date.now() + 2_000
        },
        expireAtTimestamp: Date.now() + 30_000
    };
}

function toDeliveredAck(message: ALMessage, peerId: string): ALMessage {
    const observedAtMs = Date.now();
    return newALAckControlMessage({ v: 3, msgId: `${message.id.msgId}-ack`, senderId: peerId, ts: observedAtMs }, {
        fromPeerId: peerId,
        toPeerId: message.id.senderId,
        ackedMsgId: message.id.msgId,
        originPeerId: message.id.senderId,
        logicalRecipientPeerId: peerId,
        status: 'delivered',
        observedAtEpochMs: observedAtMs,
        carrier: 'ws'
    });
}
