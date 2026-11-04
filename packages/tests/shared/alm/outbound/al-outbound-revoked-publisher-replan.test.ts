import { Temporal } from '@js-temporal/polyfill';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestALOutboundWorkPort } from '@shared-test/shared/create-test-al-outbound-work-port.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundPlanner } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { ALOutboundDispatchAdmission } from '@shared/alm/outbound/al-outbound-dispatch-admission.ts';
import type {
    ALOutboundDropReasonCode,
    ALOutboundSettlementFact
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { ALOutboundRepairAdmission } from '@shared/alm/outbound/al-outbound-repair-admission.ts';
import { ALOutboundRepairRetransmission } from '@shared/alm/outbound/al-outbound-repair-retransmission.ts';
import { EntityStatus, InMemoryQueueBox } from '@shared/mod.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import {
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    createOutboundMessage,
    readOutboundTestAdmission,
    type OutboundTestStores
} from '../outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from '../outbound-test-payload.ts';

/** The re-plan refusals compared: a revoked publisher ends its handle; every other refusal keeps its silent drop. */
type ReplanRefusal = Extract<ALOutboundDropReasonCode, 'no-publish-grant' | 'unsupported' | 'unauthorized'>;

const DEQUEUE_TYPE = 'WS_OUTBOX';

const REFUSAL_CASES: readonly [ReplanRefusal, boolean][] = [
    ['no-publish-grant', true],
    ['unsupported', false],
    ['unauthorized', false]
];

describe('a re-plan of a stored own message its sender may no longer publish', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it.each(REFUSAL_CASES)(
        'a retransmit refused %s ends the receipt and states that refusal once, so its ack-timeout restates nothing: %s',
        async (code, stated) => {
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(1_000);
            const stores = createDefaultOutboundTestStores();
            const message = createOutboundMessage(`retransmit-${code}`);
            await admitDurably(stores, message, true);
            const facts: ALOutboundSettlementFact[] = [];

            await createRetransmission(stores, facts, toRefusingPlanner(code)).retransmitByMsgId(message.id.msgId, {
                attemptIdentity: `nack-retry-${code}`
            });
            const receiptAfterRetransmit = await readReceipt(stores, message);
            await createRepairAdmission(stores, facts, toRefusingPlanner(code)).retryPendingAck(message.id.msgId);

            expect(facts).toEqual(stated ? [toRefusedFact(message, code)] : []);
            expect(receiptAfterRetransmit === undefined).toBe(stated);
        }
    );

    it('reports a hint\'s refused re-plan by its drop reason, never as a missing message', async () => {
        const warnings: string[] = [];
        vi.spyOn(console, 'warn').mockImplementation((warning: string) => {
            warnings.push(warning);
        });
        const stores = createDefaultOutboundTestStores();
        const message = createOutboundMessage('hint-no-publish-grant');
        await admitDurably(stores, message);

        await createRetransmission(stores, [], toRefusingPlanner('no-publish-grant')).retransmitFromRepairHint(
            message.id.msgId,
            { trigger: 'repair', failedPeerIds: [], missingRanges: [] },
            'hint-1'
        );

        expect(warnings).toEqual(['Skipping outbound repair of a refused re-plan: Refused no-publish-grant on re-plan']);
    });

    it.each(REFUSAL_CASES)('an ack-timeout retry refused %s ends the receipt and states that refusal: %s', async (code, stated) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000);
        const stores = createDefaultOutboundTestStores();
        const message = createOutboundMessage(`ack-timeout-${code}`);
        await admitDurably(stores, message, true);
        const facts: ALOutboundSettlementFact[] = [];

        await createRepairAdmission(stores, facts, toRefusingPlanner(code)).retryPendingAck(message.id.msgId);

        expect(facts).toEqual(stated ? [toRefusedFact(message, code)] : []);
        expect(await readReceipt(stores, message) === undefined).toBe(stated);
    });

    it.each(REFUSAL_CASES)('a dequeue refused %s completes its row and states that refusal: %s', async (code, stated) => {
        const outbox = new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(Date.now()));
        const settlements: ALDeliverySettlement[] = [];
        const message = createOutboundMessage(`dequeue-${code}`);
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            dequeue: { types: new Set([DEQUEUE_TYPE]), resilience: createDequeueResilience() },
            settlements: (settlement) => settlements.push(settlement),
            planOutgoingMessage: toRefusingPlanner(code),
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });
        const queued = QueueBoxUtilities.toResourceEntryFromMsg(message, DEQUEUE_TYPE, Temporal.Now.instant());
        await outbox.enqueueIfAbsent(queued);

        await runtime.ready();

        expect((await outbox.getItem(queued.key))?.status).toBe(EntityStatus.COMPLETED);
        expect(settlements.filter((settlement) => settlement.kind === 'admission')).toEqual(
            stated ? [expect.objectContaining(toRefusedFact(message, code))] : []
        );
    });
});

async function readReceipt(stores: OutboundTestStores, message: ReturnType<typeof createOutboundMessage>) {
    return await stores.admissionStore.readPendingAck({ originPeerId: message.id.senderId, msgId: message.id.msgId });
}

function createDequeueResilience(): ResourceInboxResilience {
    const window = Temporal.Duration.from({ milliseconds: 500 });
    return ResourceInboxResilience.createDefault(new CircuitBreakerPolicy(10, window, window, window));
}

/** A planner whose every plan of a stored message is refused with `code`. */
function toRefusingPlanner(code: ReplanRefusal): ALOutboundPlanner<OutboundTestPayload> {
    return (msg) => ({
        msg,
        dropReason: `Refused ${code} on re-plan`,
        dropReasonCode: code,
        lane: 'volatile',
        preparedMessages: []
    });
}

function toRefusedFact(message: ReturnType<typeof createOutboundMessage>, code: ReplanRefusal): ALOutboundSettlementFact {
    return {
        kind: 'admission',
        msgId: message.id.msgId,
        traceId: message.id.traceId,
        verdict: { kind: 'refused', reason: code, detail: `Refused ${code} on re-plan` },
        trackedReceiptAlgo: 'none'
    };
}

/** The message stored as admitted durably, with a due `receiver` receipt when `withReceipt` asks for one. */
async function admitDurably(
    stores: OutboundTestStores,
    message: ReturnType<typeof createOutboundMessage>,
    withReceipt = false
): Promise<void> {
    const bundle = await readOutboundTestAdmission({
        store: stores.admissionStore,
        message,
        creationNow: () => Temporal.Now.instant(),
        clock: { nowMs: () => Date.now() }
    });
    const receipt = {
        kind: 'set-pending-ack' as const,
        originPeerId: message.id.senderId,
        snapshot: {
            msgId: message.id.msgId,
            mode: 'receiver' as const,
            expectedPeerIds: ['peer-1'],
            ackedPeerIds: [],
            outsideAudiencePeerIds: [],
            timeoutMs: 2_000,
            maxAttempts: 3,
            attempts: 0,
            deadlineAtMs: 900
        },
        expireAtTimestamp: message.constraints!.expiresAtMs!
    };
    await stores.admissionStore.commitBundle({
        ...bundle,
        mutations: withReceipt ? [...bundle.mutations, receipt] : bundle.mutations
    });
}

function createRetransmission(
    stores: OutboundTestStores,
    facts: ALOutboundSettlementFact[],
    planOutgoingMessage: ALOutboundPlanner<OutboundTestPayload>
): ALOutboundRepairRetransmission<OutboundTestPayload> {
    const record = (fact: ALOutboundSettlementFact): void => {
        facts.push(fact);
    };
    return new ALOutboundRepairRetransmission({
        admissionStore: stores.admissionStore,
        dispatchAdmission: new ALOutboundDispatchAdmission({
            lane: 'durable',
            admissionStore: stores.admissionStore,
            toOutboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox', Temporal.Now.instant()),
            decodePreparedMessage: decodeOutboundTestPayload,
            clock: { nowMs: Date.now },
            browserLocks: undefined,
            diagnostics: undefined,
            settlements: record
        }),
        planOutgoingMessage,
        planRepairMessage: undefined,
        hopPeerIds: undefined,
        settlements: record
    });
}

function createRepairAdmission(
    stores: OutboundTestStores,
    facts: ALOutboundSettlementFact[],
    planOutgoingMessage: ALOutboundPlanner<OutboundTestPayload>
): ALOutboundRepairAdmission<OutboundTestPayload> {
    const clock = { nowMs: Date.now };
    return new ALOutboundRepairAdmission({
        admissionStore: stores.admissionStore,
        controlAdmission: stores.admissionStore.createControlAdmission({
            port: createTestALOutboundWorkPort({ ...stores, nowMs: Date.now }),
            clock,
            settlements: (fact) => facts.push(fact),
            carrier: 'rtc',
            hopPeerIds: undefined
        }),
        clock,
        planOutgoingMessage,
        planRepairMessage: undefined,
        hopPeerIds: undefined,
        diagnostics: undefined,
        settlements: (fact) => facts.push(fact)
    });
}
