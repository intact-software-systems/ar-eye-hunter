import { describe, expect, it } from 'vitest';

import { newALRoute, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { toALMessageTrace } from '@shared/al-contracts/trace/to-al-message-trace.ts';
import type { ALDeliveryAdmissionVerdict } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundRuntimeDiagnosticsEvent } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { settleALOutboundRelayForward } from '@shared/alm/outbound/lane/settle-al-outbound-relay-forward.ts';

const FORWARDED = newALUnicastMessage('a', newALRoute('chat', 'room-1', 'room'), 'c', 'chat.message.v1', {});

function settleVerdict(verdict: ALDeliveryAdmissionVerdict): readonly ALOutboundRuntimeDiagnosticsEvent[] {
    const events: ALOutboundRuntimeDiagnosticsEvent[] = [];
    settleALOutboundRelayForward((event) => events.push(event), FORWARDED, {
        verdict,
        message: FORWARDED,
        entries: [],
        reason: 'refused',
        trackedReceiptAlgo: 'none'
    });
    return events;
}

describe('the relay-forward-not-enqueued event', () => {
    it.each<{ verdict: ALDeliveryAdmissionVerdict; outcome: string; reason: string; }>([
        { verdict: { kind: 'skipped', reason: 'planner-drop', detail: 'd' }, outcome: 'skipped', reason: 'planner-drop' },
        { verdict: { kind: 'unroutable', reason: 'no-route', detail: 'd' }, outcome: 'unroutable', reason: 'no-route' },
        { verdict: { kind: 'refused', reason: 'congested', detail: 'd' }, outcome: 'refused', reason: 'congested' },
        { verdict: { kind: 'refused', reason: 'capacity', limit: 'admissions', detail: 'd' }, outcome: 'refused', reason: 'capacity' },
        { verdict: { kind: 'deferred', reason: 'not-yet-in-sync', detail: 'd' }, outcome: 'deferred', reason: 'not-yet-in-sync' },
        { verdict: { kind: 'superseded', detail: 'd' }, outcome: 'superseded', reason: 'none' },
        { verdict: { kind: 'expired', detail: 'd' }, outcome: 'expired', reason: 'none' },
        { verdict: { kind: 'failed', detail: 'd' }, outcome: 'failed', reason: 'none' }
    ])('names the message, its type, the $verdict.kind outcome and the reason $reason', ({ verdict, outcome, reason }) => {
        expect(settleVerdict(verdict)).toEqual([{
            kind: 'relay-forward-not-enqueued',
            msgId: FORWARDED.id.msgId,
            typeId: 'chat.message.v1',
            outcome,
            reason,
            ...toALMessageTrace(FORWARDED)
        }]);
    });

    it('is stated for a forward whose store could not persist it, with the storage cause as its reason', () => {
        const events: ALOutboundRuntimeDiagnosticsEvent[] = [];
        const result = {
            verdict: { kind: 'storage-unavailable', cause: 'quota', detail: 'full' },
            message: FORWARDED,
            entries: [],
            reason: 'full',
            trackedReceiptAlgo: 'none'
        } as const;

        expect(() => settleALOutboundRelayForward((event) => events.push(event), FORWARDED, result)).toThrow('full');
        expect(events).toMatchObject([{ kind: 'relay-forward-not-enqueued', outcome: 'storage-unavailable', reason: 'quota' }]);
    });

    it.each<ALDeliveryAdmissionVerdict>([
        { kind: 'admitted', durable: false, queuedAttempts: 1 },
        { kind: 'duplicate' },
        { kind: 'pending' }
    ])('is not stated for a forward the runtime enqueued or already holds ($kind)', (verdict) => {
        expect(settleVerdict(verdict)).toEqual([]);
    });
});
