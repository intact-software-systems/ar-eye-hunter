import {
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toALFrozenMulticastMessage } from '@shared/al-contracts/al-frozen-multicast-audience.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundPlanner } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type { ALOutboundMessageRuntime, ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';

import '../../../setup-browser-indexeddb.ts';
import {
    createOriginReceiverMulticast,
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    enqueueAndDrain
} from '../../multicast/rtc-origin-overlay-fixture.ts';
import {
    createDefaultOutboundTestRuntime,
    createIndexedDbOutboundTestStores,
    createOutboundMessage,
    createServerReceipt,
    createWsClientCarrierStores,
    createWsClientSender,
    drainOutboundWorkDueNow,
    holdOutboundClaims,
    OUTBOUND_TEST_SEND_PLANNER,
    trackOutboundTestAcks
} from '../outbound-runtime-test-fixture.ts';
import type { OutboundTestPayload } from '../outbound-test-payload.ts';

const NAMESPACE = 'ended-across-reload';
const RECEIPT_TIMEOUT_MS = 1_000;

/** One page's outbound owner over the session's IndexedDB database. */
interface PageOwner {
    readonly dbName: string;
    readonly planner: ALOutboundPlanner<OutboundTestPayload>;
    readonly stores: ALOutboundRuntimeStores<OutboundTestPayload>;
    readonly runtime: ALOutboundMessageRuntime<OutboundTestPayload>;
    /** The msgId of every frame this owner's carrier was handed, in send order. */
    readonly sent: string[];
    readonly settlements: ALDeliverySettlement[];
}

const RECEIPT_PLANNER: ALOutboundPlanner<OutboundTestPayload> = (msg, authority) => ({
    ...OUTBOUND_TEST_SEND_PLANNER(msg, authority),
    ackTracking: { ...trackOutboundTestAcks(['receiver']), timeoutMs: RECEIPT_TIMEOUT_MS }
});

/** A `receiver` multicast as an RTC origin alone in its room plans it: nobody to send to, nobody to confirm it. */
const EMPTY_AUDIENCE_PLANNER: ALOutboundPlanner<OutboundTestPayload> = (msg) => ({
    msg,
    dropReasonCode: undefined,
    lane: 'durable',
    preparedMessages: [],
    ackTracking: { ...trackOutboundTestAcks([]), mode: 'receiver', timeoutMs: RECEIPT_TIMEOUT_MS }
});

/** A page's owner: its engine is never started, so only this test's batches run its work. */
function openPageOwner(dbName: string, planner: ALOutboundPlanner<OutboundTestPayload>): PageOwner {
    const stores = createIndexedDbOutboundTestStores({
        observer: createPassThroughIndexedDbOperationObserver(),
        namespace: NAMESPACE,
        dbName
    });
    const sent: string[] = [];
    const settlements: ALDeliverySettlement[] = [];
    const runtime = createDefaultOutboundTestRuntime({
        stores,
        queueEngine: new InboxOutboxEngine(),
        settlements: (settlement) => settlements.push(settlement),
        planOutgoingMessage: planner,
        sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
            sent.push(lifecycle.canonicalMessage.id.msgId);
            return { status: 'sent', submissionAttempted: true };
        }
    });
    return { dbName, planner, stores, runtime, sent, settlements };
}

/** The page reloads: its owner is gone with every in-memory send control, and a new one opens the same database. */
async function reloadPage(page: PageOwner): Promise<PageOwner> {
    await page.runtime.dispose();
    const reloaded = openPageOwner(page.dbName, page.planner);
    await reloaded.runtime.ready();
    return reloaded;
}

/** Runs the owner's work past several receipt windows, inside the message deadline. */
async function runPastReceiptWindows(page: PageOwner): Promise<void> {
    await drainOutboundWorkDueNow(page.runtime, page.stores);
    for (let window = 0; window < 5; window += 1) {
        vi.setSystemTime(Date.now() + RECEIPT_TIMEOUT_MS * 2);
        await drainOutboundWorkDueNow(page.runtime, page.stores);
    }
}

function readSettlementKinds(page: PageOwner, msgId: string): readonly string[] {
    return page.settlements.filter((settlement) => settlement.msgId === msgId).map((settlement) => settlement.kind);
}

/**
 * What a reloaded owner states for a message that ended before the reload. A queued copy states `attempt-started`
 * before it meets the stored end at its send guards, as after every end, and then states nothing more.
 */
function readSettlementKindsPastTheGuard(page: PageOwner, msgId: string): readonly string[] {
    return readSettlementKinds(page, msgId).filter((kind) => kind !== 'attempt-started');
}

/** A `receiver` room multicast frozen to these recipients. */
function createFrozenMulticast(resourceId: string, recipientPeerIds: readonly string[]): ALMessage {
    const message = newALMulticastMessage({
        createdAtEpochMs: Date.now(),
        senderId: 'self',
        route: { topicId: 'chat', resourceId, contextId: 'room' },
        groupRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
        typeId: 'chat.message.v1',
        resource: { text: resourceId },
        options: { ack: 'all-logical-recipients', reliability: 'at-least-once', ttlMs: 30_000, traceId: `trace-${resourceId}` }
    });
    return toALFrozenMulticastMessage(message, { recipientPeerIds, snapshotVersion: 4 });
}

beforeEach(() =>
    onTestFinished(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    })
);

describe('a cancelled durable message stays cancelled across a reload', () => {
    it('sends nothing after a reload for a message cancelled while its first send was still pending', async () => {
        const page = openPageOwner(`ended-cancel-pending-${crypto.randomUUID()}`, OUTBOUND_TEST_SEND_PLANNER);
        const claims = holdOutboundClaims(page.stores);
        const message = createOutboundMessage('durable-cancel-pending');
        expect((await page.runtime.enqueueIfAbsent(message)).verdict).toMatchObject({ kind: 'admitted', durable: true });

        expect(page.runtime.cancel(message.id.msgId, message.id.traceId)).toBe('cancelled');
        await claims.release(page.runtime);
        const reloaded = await reloadPage(page);
        await drainOutboundWorkDueNow(reloaded.runtime, reloaded.stores);

        expect(readSettlementKinds(page, message.id.msgId).filter((kind) => kind === 'cancelled')).toHaveLength(1);
        expect(page.sent).toEqual([]);
        expect.soft(readSettlementKindsPastTheGuard(reloaded, message.id.msgId), 'the reloaded owner settles the cancelled message')
            .toEqual([]);
        expect(reloaded.sent, 'the reloaded owner sends the cancelled message').toEqual([]);
    });

    it('neither retransmits nor exhausts the receipt after a reload for a message cancelled once its first frame left', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const page = openPageOwner(`ended-cancel-sent-${crypto.randomUUID()}`, RECEIPT_PLANNER);
        const message = createOutboundMessage('durable-cancel-after-send');
        expect((await page.runtime.enqueueIfAbsent(message)).verdict).toMatchObject({ kind: 'admitted', durable: true });
        await drainOutboundWorkDueNow(page.runtime, page.stores);
        expect(page.sent).toEqual([message.id.msgId]);

        expect(page.runtime.cancel(message.id.msgId, message.id.traceId)).toBe('cancelled');
        const reloaded = await reloadPage(page);
        await runPastReceiptWindows(reloaded);

        expect.soft(reloaded.sent, 'the reloaded owner retransmits the cancelled message').toEqual([]);
        expect(readSettlementKindsPastTheGuard(reloaded, message.id.msgId), 'the reloaded owner settles the cancelled message')
            .toEqual([]);
    });

    it('neither admits nor sends after a reload a message cancelled while only its pending admission was retained', async () => {
        const page = openPageOwner(`ended-cancel-retained-${crypto.randomUUID()}`, OUTBOUND_TEST_SEND_PLANNER);
        const claims = holdOutboundClaims(page.stores);
        const message = createOutboundMessage('durable-cancel-retained');
        // A conflicting first commit retains the admission as `admit-message` work: no stored message row exists yet.
        vi.spyOn(page.stores.admissionStore, 'commitBundle').mockResolvedValueOnce('conflict');
        expect((await page.runtime.enqueueIfAbsent(message)).verdict.kind).toBe('pending');
        expect(await page.stores.admissionStore.hasSentMessageAdmission(message.id.msgId)).toBe(false);

        expect(page.runtime.cancel(message.id.msgId, message.id.traceId)).toBe('cancelled');
        await claims.release(page.runtime);
        const reloaded = await reloadPage(page);
        await drainOutboundWorkDueNow(reloaded.runtime, reloaded.stores);

        expect(page.sent).toEqual([]);
        expect.soft(await reloaded.stores.admissionStore.hasSentMessageAdmission(message.id.msgId), 'admitted after reload')
            .toBe(false);
        expect.soft(readSettlementKindsPastTheGuard(reloaded, message.id.msgId), 'the reloaded owner settles the cancelled message')
            .toEqual([]);
        expect(reloaded.sent, 'the reloaded owner admits and sends the cancelled message').toEqual([]);
    });
});

describe('a handed-over durable message stays handed over across a reload', () => {
    it('sends nothing and states nothing after a reload for a message handed over while its send was held', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const page = openPageOwner(`ended-hand-over-${crypto.randomUUID()}`, RECEIPT_PLANNER);
        const claims = holdOutboundClaims(page.stores);
        const message = createOutboundMessage('durable-hand-over');
        expect((await page.runtime.enqueueIfAbsent(message)).verdict).toMatchObject({ kind: 'admitted', durable: true });

        await page.runtime.handOver(message.id.msgId);
        expect(await page.stores.admissionStore.readSendGuards(message)).toEqual({ kind: 'ended' });
        await claims.release(page.runtime);
        const reloaded = await reloadPage(page);
        await runPastReceiptWindows(reloaded);

        expect(page.sent).toEqual([]);
        expect.soft(reloaded.sent, 'the reloaded owner sends the handed-over message').toEqual([]);
        expect(readSettlementKindsPastTheGuard(reloaded, message.id.msgId), 'the reloaded owner settles the handed-over message')
            .toEqual([]);
    });
});

describe('a receipt an empty frozen audience completes at admission ends its message', () => {
    it('marks the stored message ended in the admission commit', async () => {
        const page = openPageOwner(`ended-empty-audience-${crypto.randomUUID()}`, EMPTY_AUDIENCE_PLANNER);
        const message = createFrozenMulticast('empty-audience-marker', []);

        expect((await page.runtime.enqueueIfAbsent(message)).verdict).toMatchObject({ kind: 'admitted', durable: true });
        await drainOutboundWorkDueNow(page.runtime, page.stores);

        expect(page.settlements.filter((settlement) => settlement.kind === 'acknowledgement')).toEqual([
            expect.objectContaining({ msgId: message.id.msgId, mode: 'receiver', complete: true })
        ]);
        expect(await page.stores.admissionStore.readSendGuards(message)).toEqual({ kind: 'ended' });
    });

    it('skips a later retransmission as ended, before and after a reload, and sends nothing for it', async () => {
        const page = openPageOwner(`ended-empty-audience-repair-${crypto.randomUUID()}`, EMPTY_AUDIENCE_PLANNER);
        const message = createFrozenMulticast('empty-audience-repair', []);
        const retransmission = (attemptIdentity: string) => ({
            msg: message,
            plan: OUTBOUND_TEST_SEND_PLANNER(message, undefined),
            attemptIdentity
        });
        expect((await page.runtime.enqueueIfAbsent(message)).verdict).toMatchObject({ kind: 'admitted', durable: true });
        await drainOutboundWorkDueNow(page.runtime, page.stores);

        const beforeReload = await page.runtime.retransmitAdmittedMessage(retransmission('repair-before-reload'));
        await drainOutboundWorkDueNow(page.runtime, page.stores);
        const reloaded = await reloadPage(page);
        const afterReload = await reloaded.runtime.retransmitAdmittedMessage(retransmission('repair-after-reload'));
        await drainOutboundWorkDueNow(reloaded.runtime, reloaded.stores);

        expect.soft(beforeReload.verdict, 'before the reload').toMatchObject({ kind: 'skipped', reason: 'message-ended' });
        expect.soft(afterReload.verdict, 'after the reload').toMatchObject({ kind: 'skipped', reason: 'message-ended' });
        expect([...page.sent, ...reloaded.sent], 'frames sent for a message whose receipt completed').toEqual([]);
    });

    it('leaves an RTC origin alone in its room no queued row for a later dequeue of its durable send', async () => {
        vi.useFakeTimers();
        const fixture = createRtcOriginOverlayFixture({ snapshot: createOriginSnapshot(['a'], 4), nextHopPeerIds: [] });
        const original = createOriginReceiverMulticast('alone-durable');
        const message = { ...original, qos: { durability: { algo: 'local-outbox' as const } } };

        const admitted = await enqueueAndDrain(fixture.manager, message);
        await vi.advanceTimersByTimeAsync(RECEIPT_TIMEOUT_MS * 10);

        expect(admitted.verdict).toMatchObject({ kind: 'admitted', durable: true });
        const dequeueCommits = fixture.diagnostics.filter((event) =>
            event.kind === 'commit-phases' && event.msgId === message.id.msgId && event.origin === 'drain'
        );
        expect(dequeueCommits, 'a later dequeue that plans the ended message again').toEqual([]);
        expect(await fixture.resources.workQueue.getItem(admitted.entries[0]!.key), 'the canonical row a dequeue claims')
            .toMatchObject({ status: EntityStatus.COMPLETED });
        expect(await fixture.resources.admissionStore.readSendGuards(admitted.message)).toEqual({ kind: 'ended' });
        expect(fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement')).toEqual([
            expect.objectContaining({ msgId: message.id.msgId, mode: 'receiver', complete: true })
        ]);
    });

    it('states the acknowledgement once on a WS client, sends the server no copy, and refuses a late server receipt', async () => {
        const settlements: ALDeliverySettlement[] = [];
        const frames: string[] = [];
        const stores = createWsClientCarrierStores('self', 'memory');
        const sender = createWsClientSender({
            stores,
            settlements: (settlement) => settlements.push(settlement),
            diagnostics: undefined,
            sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
                frames.push(lifecycle.canonicalMessage.id.msgId);
                return { status: 'sent', submissionAttempted: true };
            }
        });
        const message = createFrozenMulticast('ws-empty-audience', []);

        expect((await sender.enqueueIfAbsent(message)).verdict.kind).toBe('admitted');
        await drainOutboundWorkDueNow(sender, stores);
        await sender.acceptReceipt(createServerReceipt(message, 'admitted', []));
        await drainOutboundWorkDueNow(sender, stores);

        expect(settlements.filter((settlement) => settlement.kind === 'acknowledgement')).toEqual([
            expect.objectContaining({ msgId: message.id.msgId, mode: 'receiver', complete: true })
        ]);
        expect(frames, 'copies written for a message nobody is left to confirm').toEqual([]);
    });

    it.each(
        [
            { label: 'a receiver send whose frozen audience names a recipient', recipients: ['b'], mode: 'receiver' },
            { label: 'a hop send whose frozen audience is empty', recipients: [], mode: 'hop' }
        ] as const
    )('leaves $label open at its admission', async ({ recipients, mode }) => {
        const planner: ALOutboundPlanner<OutboundTestPayload> = (msg) => ({
            msg,
            dropReasonCode: undefined,
            lane: 'durable',
            preparedMessages: [{ peer: 'b' }],
            ackTracking: { ...trackOutboundTestAcks(['b']), mode, timeoutMs: RECEIPT_TIMEOUT_MS }
        });
        const page = openPageOwner(`ended-open-receipt-${crypto.randomUUID()}`, planner);
        const message = createFrozenMulticast(`open-receipt-${mode}`, recipients);

        expect((await page.runtime.enqueueIfAbsent(message)).verdict).toMatchObject({ kind: 'admitted', durable: true });

        expect(await page.stores.admissionStore.readSendGuards(message)).toMatchObject({ kind: 'current' });
        expect(page.settlements.filter((settlement) => settlement.kind === 'acknowledgement')).toEqual([]);
    });
});
