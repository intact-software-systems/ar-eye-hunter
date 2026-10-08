import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { normalizeALQosPolicy } from '@shared/al-contracts/al-policy.ts';
import { createVolatileALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALDeliveryCarrier } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type {
    ALOutboundDispatchPlan,
    ALOutboundRuntimeDiagnosticsEvent,
    ALOutboundRuntimeDiagnosticsSink
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { toALOutboundMessage } from '@shared/alm/outbound/to-al-outbound-message.ts';
import {
    AL_VOLATILE_SESSION_LIMITS,
    ALVolatileSessionBudget
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

import { createDefaultOutboundTestRuntime, createOutboundMessage } from '../outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from '../outbound-test-payload.ts';

type OutboundTestPlanner = (msg: ALMessage) => ALOutboundDispatchPlan<OutboundTestPayload>;

const congestedPlanner: OutboundTestPlanner = (msg) => ({
    msg,
    dropReason: 'Carrier backpressure dropped the send',
    dropReasonCode: 'congested',
    congestionDrop: { cause: 'backpressured', priority: 0 },
    lane: 'volatile',
    preparedMessages: []
});

const overloadedPlanner: OutboundTestPlanner = (msg) => ({
    msg,
    dropReason: 'Node overloaded and congestion policy drops low-priority message',
    dropReasonCode: 'capacity',
    congestionDrop: { cause: 'overloaded', priority: 0 },
    lane: 'volatile',
    preparedMessages: []
});

/** One volatile send, with the deadline every browser planner states. */
const admittingPlanner: OutboundTestPlanner = (msg) => ({
    msg: toALOutboundMessage(msg, normalizeALQosPolicy(msg).effective),
    dropReasonCode: undefined,
    lane: 'volatile',
    preparedMessages: [{ kind: 'send' }]
});

interface ObservedRuntimeInput {
    readonly carrier: ALDeliveryCarrier;
    readonly planOutgoingMessage: OutboundTestPlanner;
    readonly diagnostics: ALOutboundRuntimeDiagnosticsSink;
    readonly budget: ALVolatileSessionBudget;
}

function createObservedRuntime(input: ObservedRuntimeInput) {
    return createDefaultOutboundTestRuntime({
        carrier: input.carrier,
        volatileStores: createVolatileALOutboundRuntimeStores({ decodePrepared: decodeOutboundTestPayload }, input.budget),
        planOutgoingMessage: input.planOutgoingMessage,
        diagnostics: input.diagnostics,
        sendPreparedMessage: async () => ({ status: 'sent' as const, submissionAttempted: true })
    });
}

function readCongestionEvents(events: readonly ALOutboundRuntimeDiagnosticsEvent[]) {
    return events.filter((event) => event.kind === 'congestion');
}

describe('the congestion decision of an outbound admission', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('states one congestion drop for an origination its planner dropped for carrier backpressure', async () => {
        const events: ALOutboundRuntimeDiagnosticsEvent[] = [];
        const runtime = createObservedRuntime({
            carrier: 'rtc',
            planOutgoingMessage: congestedPlanner,
            diagnostics: (event) => events.push(event),
            budget: new ALVolatileSessionBudget(AL_VOLATILE_SESSION_LIMITS)
        });
        const message = createOutboundMessage('congested');

        const result = await runtime.enqueueAllIfAbsent([message]);

        expect(result[0]!.verdict).toMatchObject({ kind: 'refused', reason: 'congested' });
        expect(readCongestionEvents(events)).toEqual([{
            kind: 'congestion',
            carrier: 'rtc',
            cause: 'backpressured',
            action: 'drop',
            priority: 0,
            msgId: message.id.msgId
        }]);
    });

    it('states the overloaded cause for the capacity drop the planner made', async () => {
        const events: ALOutboundRuntimeDiagnosticsEvent[] = [];
        const runtime = createObservedRuntime({
            carrier: 'ws',
            planOutgoingMessage: overloadedPlanner,
            diagnostics: (event) => events.push(event),
            budget: new ALVolatileSessionBudget(AL_VOLATILE_SESSION_LIMITS)
        });
        const message = createOutboundMessage('overloaded');

        const result = await runtime.enqueueIfAbsent(message);

        expect(result.verdict).toMatchObject({ kind: 'refused', reason: 'capacity' });
        expect(readCongestionEvents(events)).toEqual([
            expect.objectContaining({ carrier: 'ws', cause: 'overloaded', action: 'drop', msgId: message.id.msgId })
        ]);
    });

    it('states no congestion decision for a refusal of the session volatile ledger', async () => {
        const events: ALOutboundRuntimeDiagnosticsEvent[] = [];
        const runtime = createObservedRuntime({
            carrier: 'ws',
            planOutgoingMessage: admittingPlanner,
            diagnostics: (event) => events.push(event),
            budget: new ALVolatileSessionBudget({ ...AL_VOLATILE_SESSION_LIMITS, maxAdmissions: 1 })
        });

        expect((await runtime.enqueueIfAbsent(createOutboundMessage('fills-the-bound'))).verdict.kind).toBe('admitted');
        const refused = await runtime.enqueueIfAbsent(createOutboundMessage('over-the-bound'));

        expect(refused.verdict).toMatchObject({ kind: 'refused', reason: 'capacity', limit: 'admissions' });
        expect(readCongestionEvents(events)).toEqual([]);
    });

    it('keeps the verdict when its diagnostics sink throws', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const runtime = createObservedRuntime({
            carrier: 'rtc',
            planOutgoingMessage: congestedPlanner,
            diagnostics: () => {
                throw new Error('sink failed');
            },
            budget: new ALVolatileSessionBudget(AL_VOLATILE_SESSION_LIMITS)
        });

        const result = await runtime.enqueueIfAbsent(createOutboundMessage('sink-throws'));

        expect(result.verdict).toMatchObject({ kind: 'refused', reason: 'congested' });
        expect(consoleError).toHaveBeenCalledWith('AL outbound runtime diagnostics sink failed', expect.any(Error));
    });
});
