import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it,
    onTestFinished
} from 'vitest';

import { PSqlAdmissionWorkBackend } from '@shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import {
    createALOutboundAdmissionStore,
    type ALOutboundAdmissionStore,
    type ALOutboundPlanner
} from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { toALOutboundCanonicalKey } from '@shared/alm/outbound/al-outbound-canonical-message.ts';
import { toALOutboundWorkKey } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { computeALOutboundDispatch, type ALOutboundComputedDto } from '@shared/alm/outbound/compute-al-outbound-dispatch.ts';
import { toALOutboundReadMessageEndBundle } from '@shared/alm/outbound/message-end/to-al-outbound-message-end-bundle.ts';
import { toALOutboundAckTimeoutEffectId } from '@shared/alm/outbound/to-al-outbound-effect-id.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import {
    createOutboundCanonicalEntry,
    createOutboundMessage,
    readOutboundTestAdmission,
    trackOutboundTestAcks
} from '../../../shared/alm/outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from '../../../shared/alm/outbound-test-payload.ts';
import {
    createRuntimeStatePostgresSql,
    requirePostgresDatabaseUrl
} from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';
import { deleteALOutboundNamespaceRows } from './delete-al-outbound-namespace-rows.ts';

/** One durable copy whose `hop` receipt expects the receiver. */
const RECEIPTED_PLANNER: ALOutboundPlanner<OutboundTestPayload> = (msg) => ({
    msg,
    dropReasonCode: undefined,
    lane: 'durable',
    preparedMessages: [{ text: msg.id.msgId }],
    ackTracking: trackOutboundTestAcks(['receiver'])
});

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

describe('Postgres outbound message end', () => {
    postgresIt('marks the row, ends the receipt and its timer, fences a decision taken before it, and refuses the next repair', async () => {
        const store = await createStore();
        const message = createOutboundMessage('ending');
        expect(
            await store.commitBundle(
                await readOutboundTestAdmission({
                    store,
                    message,
                    creationNow: () => Temporal.Now.instant(),
                    clock: { nowMs: () => Date.now() },
                    planner: RECEIPTED_PLANNER
                })
            )
        ).toBe('committed');
        const decidedBeforeTheEnd = await decideRepair(store, message);
        const read = await store.readRepairMessage(message.id.msgId, RECEIPTED_PLANNER);
        const timeoutKey = toALOutboundWorkKey(store.namespace, toALOutboundAckTimeoutEffectId(read.pendingAck!));
        expect((await store.readWork(timeoutKey))?.status).toBe(EntityStatus.NEW);

        expect(await store.commitBundle(toALOutboundReadMessageEndBundle(message, read)))
            .toBe('committed');

        expect((await store.readStoredMessage(message.id.msgId))?.ended).toBe(true);
        expect(await store.readReceiptState({ originPeerId: message.id.senderId, msgId: message.id.msgId })).toBeUndefined();
        expect((await store.readWork(timeoutKey))?.status).toBe(EntityStatus.COMPLETED);
        expect(await store.commitBundle(decidedBeforeTheEnd.bundle!)).toBe('conflict');
        expect((await decideRepair(store, message)).verdict).toMatchObject({ kind: 'skipped', reason: 'message-ended' });
    });
});

async function createStore(): Promise<ALOutboundAdmissionStore<OutboundTestPayload>> {
    const namespace = `outbound-message-end-${crypto.randomUUID()}`;
    const canonicalKey = toALOutboundCanonicalKey(namespace, createOutboundMessage('any-message'));
    const sql = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
    onTestFinished(async () => {
        try {
            await deleteALOutboundNamespaceRows(sql, namespace, canonicalKey);
        }
        finally {
            await sql.end();
        }
    });
    return createALOutboundAdmissionStore({
        nowMs: Date.now,
        namespace,
        canonicalScope: namespace,
        decodePrepared: decodeOutboundTestPayload,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention(),
        backend: new PSqlAdmissionWorkBackend({ sql, namespace, nowMs: Date.now })
    });
}

async function decideRepair(
    store: ALOutboundAdmissionStore<OutboundTestPayload>,
    message: ALMessage
): Promise<ALOutboundComputedDto<OutboundTestPayload>> {
    const read = await store.readOutgoingMessage({
        msg: message,
        planner: RECEIPTED_PLANNER,
        observedCanonicalEntry: undefined,
        intent: 'repair',
        stampsAppliedSupersedence: false
    });
    return computeALOutboundDispatch({
        read,
        outboxEntry: createOutboundCanonicalEntry(store, read.msg, Temporal.Now.instant()),
        dispatchAtMs: Date.now(),
        intent: 'repair',
        phase: 'immediate',
        options: { attemptIdentity: 'decided-before-the-end' }
    });
}
