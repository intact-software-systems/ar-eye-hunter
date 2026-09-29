import { describe, expect, it } from 'vitest';

import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { normalizeALQosPolicy } from '@shared/al-contracts/al-policy.ts';
import { createVolatileALInboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import { toALOutboundMessage } from '@shared/alm/outbound/to-al-outbound-message.ts';
import {
    ALVolatileSessionBudget,
    type ALVolatileSessionLimits
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import { createCountingIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';

import {
    createInboundTestMessage,
    createInboundTestRuntime,
    createInboundTestStores,
    INBOUND_TEST_SELF_PEER_ID,
    INBOUND_TEST_SENDER_PEER_ID,
    INBOUND_TEST_SOURCE
} from '../inbound-runtime-test-fixture.ts';

function withDeadline(msg: ALMessage, expiresAtMs: number): ALMessage {
    return { ...msg, constraints: { ...msg.constraints, expiresAtMs } };
}

function createBudgetedInboundRuntime(limits: ALVolatileSessionLimits) {
    const budget = new ALVolatileSessionBudget(limits);
    const fixture = createInboundTestRuntime({
        carrier: 'ws',
        stores: createInboundTestStores({
            namespace: 'inbound-budget',
            storage: 'memory',
            observer: createCountingIndexedDbOperationObserver()
        }),
        volatileStores: createVolatileALInboundRuntimeStores({
            namespace: 'inbound-budget-volatile'
        }, budget),
        effectWorkerId: 'al-inbound:budget'
    });
    return { budget, runtime: fixture.runtime };
}

describe('the session volatile bound at the inbound admission (D74, C6)', () => {
    it('records a volatile data admission with its envelope bytes', async () => {
        const { budget, runtime } = createBudgetedInboundRuntime({
            maxAdmissions: 10,
            maxBytes: 1_000_000
        });

        const admitted = await runtime.admitIncomingMessage(
            createInboundTestMessage({ msgId: 'received-1' }),
            INBOUND_TEST_SOURCE
        );

        expect(admitted.right).toEqual({ kind: 'admitted' });
        expect(budget.readUsage(Date.now()).admissions).toBe(1);
        expect(budget.readUsage(Date.now()).bytes).toBeGreaterThan(0);
    });

    it('admits past the bound, counting each arrival toward overloaded', async () => {
        const { budget, runtime } = createBudgetedInboundRuntime({
            maxAdmissions: 1,
            maxBytes: 1_000_000
        });

        const first = await runtime.admitIncomingMessage(
            createInboundTestMessage({ msgId: 'received-1' }),
            INBOUND_TEST_SOURCE
        );
        const second = await runtime.admitIncomingMessage(
            createInboundTestMessage({ msgId: 'received-2' }),
            INBOUND_TEST_SOURCE
        );

        expect(first.right).toEqual({ kind: 'admitted' });
        expect(second.right).toEqual({ kind: 'admitted' });
        expect(budget.readUsage(Date.now()).admissions).toBe(2);
        expect(budget.isOverloaded(Date.now())).toBe(true);
    });

    it('counts a copy of one message once', async () => {
        const { budget, runtime } = createBudgetedInboundRuntime({
            maxAdmissions: 10,
            maxBytes: 1_000_000
        });
        const message = createInboundTestMessage({ msgId: 'received-twice' });

        await runtime.admitIncomingMessage(message, INBOUND_TEST_SOURCE);
        const copy = await runtime.admitIncomingMessage(message, INBOUND_TEST_SOURCE);

        expect(copy.right).toEqual({ kind: 'duplicate' });
        expect(budget.readUsage(Date.now()).admissions).toBe(1);
    });

    it('does not count a local-inbox message, which the durable lane admits', async () => {
        const { budget, runtime } = createBudgetedInboundRuntime({
            maxAdmissions: 10,
            maxBytes: 1_000_000
        });

        const admitted = await runtime.admitIncomingMessage(
            createInboundTestMessage({ msgId: 'durable', durability: 'local-inbox' }),
            INBOUND_TEST_SOURCE
        );

        expect(admitted.right).toEqual({ kind: 'admitted' });
        expect(budget.readUsage(Date.now()).admissions).toBe(0);
    });

    it('counts an arrival whose sender named a deadline an hour ahead for 30 s only (R-S3c-ii-6)', async () => {
        const { budget, runtime } = createBudgetedInboundRuntime({ maxAdmissions: 10, maxBytes: 1_000_000 });
        const admittedFromMs = Date.now();
        const message = withDeadline(createInboundTestMessage({ msgId: 'an-hour-ahead' }), admittedFromMs + 3_600_000);

        const admitted = await runtime.admitIncomingMessage(message, INBOUND_TEST_SOURCE);
        const admittedByMs = Date.now();

        expect(admitted.right).toEqual({ kind: 'admitted' });
        expect(budget.readUsage(admittedFromMs + 29_999).admissions).toBe(1);
        expect(budget.readUsage(admittedByMs + 30_000).admissions).toBe(0);
    });

    it('releases an arrival at its own deadline when that comes before 30 s', async () => {
        const { budget, runtime } = createBudgetedInboundRuntime({ maxAdmissions: 10, maxBytes: 1_000_000 });
        const deadlineAtMs = Date.now() + 5_000;

        await runtime.admitIncomingMessage(
            withDeadline(createInboundTestMessage({ msgId: 'five-seconds' }), deadlineAtMs),
            INBOUND_TEST_SOURCE
        );

        expect(budget.readUsage(deadlineAtMs - 1).admissions).toBe(1);
        expect(budget.readUsage(deadlineAtMs).admissions).toBe(0);
    });

    it('does not count a received RTC signal, whose deadline is only the carrier\'s lifetime stamp (R-S3c-ii-3)', async () => {
        const { budget, runtime } = createBudgetedInboundRuntime({ maxAdmissions: 10, maxBytes: 1_000_000 });
        const signal = newALUnicastMessage(
            INBOUND_TEST_SENDER_PEER_ID,
            { topicId: 'rtc-signaling', resourceId: INBOUND_TEST_SELF_PEER_ID, contextId: INBOUND_TEST_SELF_PEER_ID },
            INBOUND_TEST_SELF_PEER_ID,
            'rtc-signaling',
            { kind: 'offer' }
        );
        // As the sender's WS planner and the server's relay plan emit it.
        const planned = toALOutboundMessage(signal, normalizeALQosPolicy(signal).effective);

        const admitted = await runtime.admitIncomingMessage(planned, INBOUND_TEST_SOURCE);

        expect(planned.constraints?.expiresAtMs).toBeDefined();
        expect(admitted.right).toEqual({ kind: 'admitted' });
        expect(budget.readUsage(Date.now()).admissions).toBe(0);
    });
});
