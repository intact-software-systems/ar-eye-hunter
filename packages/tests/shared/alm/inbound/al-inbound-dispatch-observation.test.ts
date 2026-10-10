import {
    expect,
    it,
    onTestFinished,
    vi,
    type Mock
} from 'vitest';

import { planALMessageHandling, type ALMessageHandlingPlan } from '@shared/al-contracts/al-policy.ts';
import { createVolatileALInboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import { ALInboundAdmittedDelivery, type ALInboundDeliveryObservation } from '@shared/alm/inbound/al-inbound-admitted-delivery.ts';
import { toALInboundMessageReference } from '@shared/alm/inbound/al-inbound-canonical-message.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import {
    computeALInboundWorkEntry,
    decodeALInboundWorkEntry,
    type ALPersistedInboundEffect
} from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { createDefaultALInboundRuntimeResources } from '@shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import {
    createInboundTestMessage,
    createInboundTestRuntime,
    createInboundTestStores,
    INBOUND_TEST_SOURCE
} from '../inbound-runtime-test-fixture.ts';

interface DispatchFixtureInput {
    readonly returned: 'completed' | 'retry' | Error;
    readonly canDispatch: boolean;
    readonly sinkThrows: boolean;
}

interface DispatchFixture {
    readonly delivery: ALInboundAdmittedDelivery;
    readonly canDispatchMessage: Mock<() => boolean>;
    readonly resources: ALInboundMessageRuntime.Resources;
    readonly calls: readonly string[];
    readonly events: readonly ALInboundRuntimeDiagnosticsEvent[];
}

interface ObservedDispatch {
    readonly effect: ALPersistedInboundEffect;
    readonly observed: ALInboundDeliveryObservation;
}

function createDispatchFixture(input: DispatchFixtureInput): DispatchFixture {
    const events: ALInboundRuntimeDiagnosticsEvent[] = [];
    const calls: string[] = [];
    const canDispatchMessage = vi.fn(() => input.canDispatch);
    const resources = createDefaultALInboundRuntimeResources({
        selfPeerId: 'receiver',
        nowMs: () => 100,
        queueEngine: new InboxOutboxEngine(),
        toInboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'inbox')
    });
    const delivery = new ALInboundAdmittedDelivery({
        ...resources,
        lane: 'durable',
        effectWorkerId: 'worker',
        planIncomingMessage: (msg) => planALMessageHandling(msg, { selfPeerId: 'receiver', nowMs: 100 }),
        canDispatchMessage,
        dispatchInboxEntry: async () => {
            calls.push('port');
            if (input.returned instanceof Error) {
                throw input.returned;
            }
            return input.returned;
        },
        diagnostics: (event: ALInboundRuntimeDiagnosticsEvent) => {
            events.push(event);
            if (input.sinkThrows) {
                throw new Error('private diagnostic failure');
            }
        }
    });
    onTestFinished(() => delivery.dispose());
    return { delivery, resources, calls, events, canDispatchMessage };
}

function createObservedDispatch(planChange: (plan: ALMessageHandlingPlan) => ALMessageHandlingPlan, ordered = false): ObservedDispatch {
    const original = createInboundTestMessage({ msgId: 'signal', seq: ordered ? 1 : undefined });
    const msg = { ...original, payload: { ...original.payload, typeId: 'rtc-signaling' } };
    const written = computeALInboundWorkEntry({
        namespace: 'al-inbound-runtime',
        effectId: 'dispatch:sender:signal',
        payload: { kind: 'dispatch-local', message: toALInboundMessageReference(msg) },
        observedAtMs: 0,
        expireAtTimestamp: 1000,
        carrier: 'ws'
    });
    const effect = decodeALInboundWorkEntry(written.entry, 'al-inbound-runtime');
    return {
        effect,
        observed: { msg, source: { kind: 'trusted-server' as const }, plan: planChange(planALMessageHandling(msg, { selfPeerId: 'receiver', nowMs: 100 })) }
    };
}

it.each(
    [
        ['disabled', 'local-disabled', (plan: ALMessageHandlingPlan) => ({ ...plan, localDelivery: { ...plan.localDelivery, enabled: false } })],
        ['dropped', 'plan-dropped', (plan: ALMessageHandlingPlan) => ({ ...plan, dropReason: 'private reason' })]
    ] as const
)('distinguishes completed %s work from an actual dispatch call', async (_name, disposition, planChange) => {
    const fixture = createDispatchFixture({ returned: 'completed', canDispatch: true, sinkThrows: false });
    const { effect, observed } = createObservedDispatch(planChange);
    expect(await fixture.delivery.deliver(effect, observed)).toBe('completed');
    expect(fixture.calls).toEqual([]);
    expect(fixture.events).toEqual([{
        kind: 'dispatch-decision',
        lane: 'durable',
        workerId: 'worker',
        effectId: 'dispatch:sender:signal',
        msgId: 'signal',
        typeId: 'rtc-signaling',
        carrier: 'ws',
        attempts: 0,
        atEpochMs: 100,
        disposition
    }]);
});

it.each(
    [
        ['completed', true, 'port-returned', ['port']],
        ['retry', true, 'port-retry', ['port']],
        ['completed', false, 'consumer-unavailable', []]
    ] as const
)('records %s with readiness %s without inferring a selected consumer', async (returned, canDispatch, disposition, calls) => {
    const fixture = createDispatchFixture({ returned, canDispatch, sinkThrows: false });
    const { effect, observed } = createObservedDispatch((plan) => plan);
    expect(await fixture.delivery.deliver(effect, observed)).toBe(canDispatch ? returned : 'retry');
    expect(fixture.calls).toEqual(calls);
    expect(fixture.events).toMatchObject([{ kind: 'dispatch-decision', disposition, msgId: 'signal' }]);
});

it('preserves a thrown port error even when the diagnostic sink throws', async () => {
    const original = new Error('private original error');
    const fixture = createDispatchFixture({ returned: original, canDispatch: true, sinkThrows: true });
    const { effect, observed } = createObservedDispatch((plan) => plan);
    await expect(fixture.delivery.deliver(effect, observed)).rejects.toBe(original);
    expect(fixture.calls).toEqual(['port']);
    expect(fixture.events).toMatchObject([{ disposition: 'port-threw' }]);
    expect(JSON.stringify(fixture.events)).not.toContain('private');
});

it.each([['completed', 1, undefined, 'ordering-completed'], ['retry', 0, { kind: 'effect' }, 'ordering-retry']] as const)(
    'records ordered %s without invoking the port',
    async (outcome, completedThrough, predecessor, disposition) => {
        const fixture = createDispatchFixture({ returned: 'completed', canDispatch: true, sinkThrows: false });
        vi.spyOn(fixture.resources.admissionStore, 'readOrderedDelivery').mockResolvedValue({ completedThrough, predecessor });
        const { effect, observed } = createObservedDispatch((plan) => plan, true);
        expect(await fixture.delivery.deliver(effect, observed)).toBe(outcome);
        expect(fixture.calls).toEqual([]);
        expect(fixture.events).toMatchObject([{ disposition }]);
    }
);

it('records a plan retry before any port call', async () => {
    const fixture = createDispatchFixture({ returned: 'completed', canDispatch: true, sinkThrows: false });
    const { effect, observed } = createObservedDispatch((plan) => ({ ...plan, dropReasonCode: 'not-yet-in-sync' }));
    expect(await fixture.delivery.deliver(effect, observed)).toBe('retry');
    expect(fixture.calls).toEqual([]);
    expect(fixture.events).toMatchObject([{ disposition: 'plan-retry' }]);
});

it('keeps shutdown and expiry ahead of dispatch and preserves their original outcomes', async () => {
    const fixture = createDispatchFixture({ returned: 'completed', canDispatch: true, sinkThrows: true });
    const { effect, observed } = createObservedDispatch((plan) => plan);
    await expect(fixture.delivery.deliver({ ...effect, expireAtTimestamp: 100 }, observed)).rejects.toThrow('Inbound work expired before delivery');
    fixture.delivery.dispose();
    expect(await fixture.delivery.deliver(effect, observed)).toBe('retry');
    expect(fixture.calls).toEqual([]);
    expect(fixture.events).toMatchObject([{ disposition: 'expired' }, { disposition: 'shutdown' }]);
});

it('leaves ordered completion after the port even when supplemental diagnostics fail', async () => {
    const fixture = createDispatchFixture({ returned: 'completed', canDispatch: true, sinkThrows: true });
    const { effect, observed } = createObservedDispatch((plan) => plan);
    expect(await fixture.delivery.deliver(effect, observed)).toBe('completed');
    expect(fixture.calls).toEqual(['port']);
    expect(fixture.events).toMatchObject([{ disposition: 'port-returned' }]);
});

it('keeps the actual durable and volatile worker identities separate across concurrent lanes', async () => {
    const fixture = createInboundTestRuntime({
        carrier: 'ws',
        effectWorkerId: 'worker',
        stores: createInboundTestStores({ namespace: 'durable', storage: 'memory', observer: createPassThroughIndexedDbOperationObserver() }),
        volatileStores: createVolatileALInboundRuntimeStores({ namespace: 'volatile' }, undefined)
    });
    await fixture.runtime.ready();
    await Promise.all([
        fixture.runtime.admitIncomingMessage(createInboundTestMessage({ msgId: 'durable', durability: 'local-inbox' }), INBOUND_TEST_SOURCE),
        fixture.runtime.admitIncomingMessage(createInboundTestMessage({ msgId: 'volatile', durability: 'volatile' }), INBOUND_TEST_SOURCE)
    ]);
    await expect.poll(() => fixture.delivered.length).toBe(2);
    const decisions = fixture.diagnostics.filter((event) => event.kind === 'dispatch-decision');
    expect(decisions).toHaveLength(2);
    expect(decisions).toEqual(expect.arrayContaining([
        expect.objectContaining({ msgId: 'durable', lane: 'durable', workerId: 'worker', carrier: 'ws', attempts: 1, disposition: 'port-returned' }),
        expect.objectContaining({ msgId: 'volatile', lane: 'volatile', workerId: 'worker/volatile', carrier: 'ws', attempts: 1, disposition: 'port-returned' })
    ]));
});

it.each([false, true])('preserves readiness callback disposal when the callback returns %s', async (ready) => {
    const fixture = createDispatchFixture({ returned: 'completed', canDispatch: true, sinkThrows: false });
    fixture.canDispatchMessage.mockImplementation(() => {
        fixture.delivery.dispose();
        return ready;
    });
    const { effect, observed } = createObservedDispatch((plan) => plan);

    expect(await fixture.delivery.deliver(effect, observed)).toBe(ready ? 'completed' : 'retry');
    expect(fixture.canDispatchMessage).toHaveBeenCalledTimes(1);
    expect(fixture.calls).toEqual(ready ? ['port'] : []);
    expect(fixture.events).toMatchObject([{ disposition: ready ? 'port-returned' : 'shutdown' }]);
});
