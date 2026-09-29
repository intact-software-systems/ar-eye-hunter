import { describe, expect, it } from 'vitest';

import { createVolatileALInboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import {
    ALVolatileSessionBudget,
    type ALVolatileSessionLimits
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import { createCountingIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';

import {
    createInboundTestMessage,
    createInboundTestRuntime,
    createInboundTestStores,
    INBOUND_TEST_SOURCE
} from '../inbound-runtime-test-fixture.ts';

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
});
