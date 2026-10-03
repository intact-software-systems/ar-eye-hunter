import { describe, expect, it } from 'vitest';

import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    newALAckControlMessage,
    newALNackControlMessage,
    newALReceiptControlMessage
} from '@shared/al-contracts/al-control.ts';
import { normalizeALQosPolicy, type ALQosNormalizationInput } from '@shared/al-contracts/al-policy.ts';
import { createVolatileALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALDeliveryCarrier } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundDispatchPlan } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { toALOutboundMessage } from '@shared/alm/outbound/to-al-outbound-message.ts';
import {
    AL_VOLATILE_SESSION_MAX_ADMISSIONS,
    AL_VOLATILE_SESSION_MAX_BYTES,
    ALVolatileSessionBudget
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

import {
    createDefaultOutboundTestRuntime,
    createOutboundMessage
} from '../outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from '../outbound-test-payload.ts';

const DURABLE_TYPE_ID = 'chat.durable.v1';

/**
 * Volatile unless the message's type says durable, with one prepared send and the envelope every browser
 * planner states: `toALOutboundMessage` over the normalized policy, which gives a message without a deadline
 * the default lifetime.
 */
function planByTypeId(
    msg: ALMessage,
    normalization: ALQosNormalizationInput = {}
): ALOutboundDispatchPlan<OutboundTestPayload> {
    return {
        msg: toALOutboundMessage(msg, normalizeALQosPolicy(msg, normalization).effective),
        dropReasonCode: undefined,
        lane: msg.payload.typeId === DURABLE_TYPE_ID ? 'durable' : 'volatile',
        preparedMessages: [{ kind: 'send' }]
    };
}

function createBudgetedRuntime(
    budget: ALVolatileSessionBudget,
    carrier: ALDeliveryCarrier = 'ws',
    planOutgoingMessage: (msg: ALMessage) => ALOutboundDispatchPlan<OutboundTestPayload> = planByTypeId
) {
    return createDefaultOutboundTestRuntime({
        carrier,
        volatileStores: createVolatileALOutboundRuntimeStores({
            decodePrepared: decodeOutboundTestPayload
        }, budget),
        planOutgoingMessage,
        sendPreparedMessage: async () => ({ status: 'sent' as const, submissionAttempted: true })
    });
}

function createDefaultBudget(): ALVolatileSessionBudget {
    return new ALVolatileSessionBudget({
        maxAdmissions: AL_VOLATILE_SESSION_MAX_ADMISSIONS,
        maxBytes: AL_VOLATILE_SESSION_MAX_BYTES
    });
}

/** One volatile admission short of a full bound, so this session's next data admission is its 1 000th. */
function recordReceivedUntilOneShort(budget: ALVolatileSessionBudget): void {
    const nowMs = Date.now();
    for (let index = 0; index < AL_VOLATILE_SESSION_MAX_ADMISSIONS - 1; index += 1) {
        budget.record({
            msgId: `received-${index}`,
            bytes: 1,
            deadlineAtMs: nowMs + 60_000,
            nowMs
        });
    }
}

/** A budget of one, filled by one volatile data admission of the runtime under test. */
async function createFullRuntime() {
    const budget = new ALVolatileSessionBudget({
        maxAdmissions: 1,
        maxBytes: AL_VOLATILE_SESSION_MAX_BYTES
    });
    const runtime = createBudgetedRuntime(budget);
    expect((await runtime.enqueueIfAbsent(createOutboundMessage('fills-the-bound'))).verdict.kind)
        .toBe('admitted');
    return { budget, runtime };
}

describe('the session volatile bound at the outbound admission (D74, D78)', () => {
    it('refuses the 1 001st volatile data admission with the drop code capacity', async () => {
        const budget = createDefaultBudget();
        recordReceivedUntilOneShort(budget);
        const runtime = createBudgetedRuntime(budget);

        const thousandth = await runtime.enqueueIfAbsent(createOutboundMessage('volatile-1000'));
        const refused = await runtime.enqueueIfAbsent(createOutboundMessage('volatile-1001'));

        expect(thousandth.verdict).toMatchObject({ kind: 'admitted', durable: false });
        expect(refused.verdict).toMatchObject({ kind: 'refused', reason: 'capacity' });
        expect(refused.reason).toContain('volatile bound');
        expect(refused.entries).toEqual([]);
        expect(budget.readUsage(Date.now()).admissions).toBe(AL_VOLATILE_SESSION_MAX_ADMISSIONS);
    });

    it('counts each member of a group this session sends, in order', async () => {
        const budget = new ALVolatileSessionBudget({
            maxAdmissions: 2,
            maxBytes: AL_VOLATILE_SESSION_MAX_BYTES
        });
        const runtime = createBudgetedRuntime(budget);

        const results = await runtime.enqueueAllIfAbsent([
            createOutboundMessage('group-1'),
            createOutboundMessage('group-2'),
            createOutboundMessage('group-3')
        ]);

        expect(results.map(({ verdict }) => verdict.kind)).toEqual([
            'admitted',
            'admitted',
            'refused'
        ]);
        expect(results[2]?.verdict).toMatchObject({ kind: 'refused', reason: 'capacity' });
    });

    it('counts a msgId once when a second carrier re-admits it, as the WS leg of a fallback does', async () => {
        const budget = new ALVolatileSessionBudget({
            maxAdmissions: 1,
            maxBytes: AL_VOLATILE_SESSION_MAX_BYTES
        });
        const rtc = createBudgetedRuntime(budget, 'rtc');
        const ws = createBudgetedRuntime(budget, 'ws');
        const message = createOutboundMessage('handed-over');

        expect((await rtc.enqueueIfAbsent(message)).verdict.kind).toBe('admitted');
        expect((await ws.enqueueIfAbsent(message)).verdict.kind).toBe('admitted');
        expect(budget.readUsage(Date.now()).admissions).toBe(1);
    });

    it('never counts an ACK batch, even one that carries a deadline', async () => {
        const { budget, runtime } = await createFullRuntime();
        const ack = newALAckControlMessage(
            { v: 2, msgId: 'ack-at-the-bound', senderId: 'self', ts: Date.now() },
            {
                ackedMsgId: 'received-message',
                fromPeerId: 'self',
                toPeerId: 'peer-1',
                originPeerId: 'peer-1',
                logicalRecipientPeerId: 'self',
                carrier: 'ws',
                status: 'delivered',
                observedAtEpochMs: Date.now()
            }
        );
        // A deadline, so only the control rule can exempt it.
        const [acked] = await runtime.enqueueAllIfAbsent([{
            ...ack,
            constraints: { expiresAtMs: Date.now() + 30_000 }
        }]);

        expect(acked?.verdict.kind).toBe('admitted');
        expect(budget.readUsage(Date.now()).admissions).toBe(1);
    });

    it.each([
        [
            'a NACK',
            newALNackControlMessage(
                { v: 2, msgId: 'nack-at-the-bound', senderId: 'self', ts: Date.now() },
                {
                    fromPeerId: 'self',
                    toPeerId: 'peer-1',
                    msgId: 'received-message',
                    reason: 'gap',
                    observedAtEpochMs: Date.now()
                }
            )
        ],
        [
            'a receipt',
            newALReceiptControlMessage(
                { v: 2, msgId: 'receipt-at-the-bound', senderId: 'self', ts: Date.now() },
                {
                    msgId: 'received-message',
                    originPeerId: 'peer-1',
                    expectedRecipientPeerIds: ['self'],
                    confirmedRecipientPeerIds: ['self'],
                    snapshotVersion: 1,
                    phase: 'complete',
                    observedAtEpochMs: Date.now()
                }
            )
        ]
    ])('never counts %s this session sends at a full bound, even one that carries a deadline', async (_, control) => {
        const { budget, runtime } = await createFullRuntime();

        const [sent] = await runtime.enqueueAllIfAbsent([{
            ...control,
            constraints: { expiresAtMs: Date.now() + 30_000 }
        }]);

        expect(sent?.verdict.kind).toBe('admitted');
        expect(budget.readUsage(Date.now()).admissions).toBe(1);
    });

    it('never counts a relay forward, whose admission carries its plan', async () => {
        const { budget, runtime } = await createFullRuntime();
        const forward = createOutboundMessage('relayed');

        expect((await runtime.enqueueIfAbsent(forward, planByTypeId(forward))).verdict)
            .toMatchObject({ kind: 'admitted', durable: false });
        expect(budget.readUsage(Date.now()).admissions).toBe(1);
    });

    it('never counts a durable send', async () => {
        const { budget, runtime } = await createFullRuntime();
        const durable = newALUnicastMessage(
            'self',
            { topicId: 'chat', resourceId: 'durable', contextId: 'conversation-1' },
            'peer-1',
            DURABLE_TYPE_ID,
            { text: 'durable' },
            { ttlMs: 30_000 }
        );

        expect((await runtime.enqueueIfAbsent(durable)).verdict).toMatchObject({
            kind: 'admitted',
            durable: true
        });
        expect(budget.readUsage(Date.now()).admissions).toBe(1);
    });

    it('never counts a volatile message without a deadline, as an RTC signal is sent', async () => {
        const { budget, runtime } = await createFullRuntime();
        const signal = newALUnicastMessage(
            'self',
            { topicId: 'rtc-signaling', resourceId: 'offer', contextId: 'peer-1' },
            'peer-1',
            'rtc-signaling',
            { kind: 'offer' }
        );

        expect((await runtime.enqueueIfAbsent(signal)).verdict).toMatchObject({
            kind: 'admitted',
            durable: false
        });
        expect(budget.readUsage(Date.now()).admissions).toBe(1);
    });

    it('releases a counted send at its planned deadline, which the effective QoS expiry may bring forward', async () => {
        const budget = createDefaultBudget();
        const runtime = createBudgetedRuntime(
            budget,
            'ws',
            (msg) => planByTypeId(msg, { defaults: { expiry: { algo: 'fresh-until', opts: { maxStalenessMs: 5_000 } } } })
        );
        const message = createOutboundMessage('fresh-for-five-seconds');

        expect((await runtime.enqueueIfAbsent(message)).verdict.kind).toBe('admitted');

        expect(budget.readUsage(message.id.ts + 4_999).admissions).toBe(1);
        expect(budget.readUsage(message.id.ts + 5_000).admissions).toBe(0);
    });

    it('never counts a retransmission, which carries its own plan', async () => {
        const budget = new ALVolatileSessionBudget({
            maxAdmissions: 1,
            maxBytes: AL_VOLATILE_SESSION_MAX_BYTES
        });
        const runtime = createBudgetedRuntime(budget);
        const relayed = createOutboundMessage('relayed-then-retried');
        expect((await runtime.enqueueIfAbsent(relayed, planByTypeId(relayed))).verdict.kind).toBe('admitted');
        budget.record({ msgId: 'received', bytes: 1, deadlineAtMs: Date.now() + 10_000, nowMs: Date.now() });

        const retried = await runtime.retransmitAdmittedMessage({
            msg: relayed,
            plan: planByTypeId(relayed),
            attemptIdentity: 'retry-1'
        });

        expect(retried.verdict).toMatchObject({ kind: 'admitted', durable: false });
        expect(budget.readUsage(Date.now()).admissions).toBe(1);
    });
});
