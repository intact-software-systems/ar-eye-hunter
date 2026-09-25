import { describe, expect, it } from 'vitest';

import { computeAlmConformanceQosDefaults } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/compute-alm-conformance-qos-defaults.ts';
import { computeFallbackDisposition } from '@shared-web/browser/messages/browser-rallar-message-dispatch.ts';
import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { normalizeALQosPolicy, resolveALQosNormalizationInput } from '@shared/al-contracts/al-policy.ts';
import { toALReceiverAckNormalizationInput } from '@shared/al-contracts/validate-al-ack-support.ts';
import type { ALDeliveryAdmissionVerdict, ALDeliveryCarrier } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { computeALOutboundAckRefusal } from '@shared/alm/outbound/admission/compute-al-outbound-ack-refusal.ts';

const room = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
const specimen = newALMulticastMessage('sender', { topicId: 'room.lifecycle', contextId: 'room', resourceId: 'old' }, room, 'alm.lifecycle', {
    marker: 'delivery-lifecycle',
    specimen: 'supersedence'
});
const provider = { defaultsForMessage: computeAlmConformanceQosDefaults };

describe('black-box conformance QoS policy', () => {
    it('uses one collision-safe slot per sender, application, workspace, room and message type', () => {
        const selected = normalizeALQosPolicy(specimen, resolveALQosNormalizationInput(specimen, { direction: 'outbound' }, provider));
        expect(selected.effective.supersedence).toEqual({
            algo: 'latest-wins',
            opts: { supersedenceKey: '["sender","app","workspace","room","alm.lifecycle"]' }
        });
        const variants: ALMessage[] = [
            { ...specimen, id: { ...specimen.id, senderId: 'other' } },
            { ...specimen, payload: { ...specimen.payload, typeId: 'other' } },
            ...[
                { ...room, applicationId: 'other' },
                { ...room, workspaceId: 'other' },
                { ...room, groupId: 'other' },
                { ...room, applicationId: 'app/workspace', workspaceId: 'room', groupId: '' }
            ].map((groupRef): ALMessage => ({ ...specimen, targets: { mode: 'multicast', groupRef } }))
        ];
        const keys = [specimen, ...variants].map((message) =>
            computeAlmConformanceQosDefaults(message, { direction: 'outbound' })?.supersedence?.opts.supersedenceKey
        );
        expect(keys.every((key) => key !== undefined)).toBe(true);
        expect(new Set(keys).size).toBe(keys.length);
    });
    it('keeps ordinary facade, ordinary messages, inbound and unscoped traffic on the default policy', () => {
        expect(normalizeALQosPolicy(specimen).effective.supersedence.algo).toBe('none');
        expect(computeAlmConformanceQosDefaults(specimen, { direction: 'inbound' })).toBeUndefined();
        expect(computeAlmConformanceQosDefaults({ ...specimen, targets: undefined }, { direction: 'outbound' })).toBeUndefined();
        for (const resource of ['null', '[]', '{}', 'not-json', '{"marker":"delivery-lifecycle"}', '{"marker":"ordinary","specimen":"supersedence"}']) {
            const message = { ...specimen, payload: { ...specimen.payload, resource } };
            const selected = normalizeALQosPolicy(message, resolveALQosNormalizationInput(message, { direction: 'outbound' }, provider));
            expect(selected.effective.supersedence.algo).toBe('none');
        }
    });
    // S2c-ii flips the rtc row once the overlay declares receiver. Until then rtc refuses it, and the fallback strategy
    // hands the same receiver envelope to ws: the carrier changes, never the algorithm.
    it.each(
        [
            { strategy: 'ws', legs: ['ws'], outcome: { carrier: 'ws', verdict: ADMITTED } },
            { strategy: 'rtc', legs: ['rtc'], outcome: { carrier: 'rtc', verdict: RTC_REFUSAL } },
            { strategy: 'rtc-with-ws-fallback', legs: ['rtc', 'ws'], outcome: { carrier: 'ws', verdict: ADMITTED } }
        ] as const
    )('keeps receiver on the $strategy room send and settles it on the carrier that supports it', ({ legs, outcome }) => {
        const message = { ...specimen, delivery: { reliability: 'at-least-once', ack: 'receiver' } } as const;
        const admissions = legs.map((carrier) => toLegAdmission(message, carrier));
        const settled = admissions.find((admission, index) =>
            index === admissions.length - 1 || computeFallbackDisposition(admission.verdict, undefined, 0) !== 'retry'
        );

        expect(admissions.map((admission) => admission.algo)).toEqual(legs.map(() => 'receiver'));
        expect(settled && { carrier: settled.carrier, verdict: settled.verdict }).toEqual(outcome);
    });
});

const ADMITTED = { kind: 'admitted', durable: false, queuedAttempts: 1 } as const;
const RTC_REFUSAL = {
    kind: 'refused',
    reason: 'unsupported',
    detail: 'ack receiver is unsupported for rtc multicast targets'
} as const;

/** One carrier leg's admission of the send: its normalized ack algorithm and the verdict its ack support gives. */
function toLegAdmission(message: ALMessage, carrier: ALDeliveryCarrier) {
    const policy = normalizeALQosPolicy(message, toCarrierNormalizationInput(message, carrier));
    const verdict = computeALOutboundAckRefusal({ msg: message, carrier, policy }).fold<ALDeliveryAdmissionVerdict>(
        (refusal) => ({ kind: 'refused', reason: 'unsupported', detail: refusal.dropReason ?? '' }),
        () => ADMITTED
    );
    return { carrier, algo: policy.effective.ack.algo, verdict };
}

/** The ws carrier declares receiver; the rtc overlay does not until S2c-ii. */
function toCarrierNormalizationInput(message: ALMessage, carrier: ALDeliveryCarrier) {
    const input = resolveALQosNormalizationInput(message, { direction: 'outbound' }, provider);
    return carrier === 'ws' ? toALReceiverAckNormalizationInput(input) : input;
}
