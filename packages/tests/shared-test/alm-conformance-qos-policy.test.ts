import { describe, expect, it } from 'vitest';

import { computeFallbackDisposition } from '@shared-web/browser/messages/browser-rallar-message-dispatch.ts';
import {
    AL_RTC_OVERLAY_CAPABILITIES,
    AL_WS_CLIENT_CAPABILITIES,
    toALCarrierQosInputProvider
} from '@shared/al-contracts/al-carrier-capabilities.ts';
import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALDeliveryCarrier } from '@shared/al-contracts/al-control-value-codec.ts';
import { normalizeALQosPolicy, resolveALQosNormalizationInput } from '@shared/al-contracts/al-policy.ts';
import type { ALDeliveryAdmissionVerdict } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { computeALOutboundAckRefusal } from '@shared/alm/outbound/admission/compute-al-outbound-ack-refusal.ts';

const roomSend = newALMulticastMessage({
    createdAtEpochMs: Date.now(),
    senderId: 'sender',
    route: { topicId: 'room.lifecycle', contextId: 'room', resourceId: 'room-send' },
    groupRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
    typeId: 'alm.lifecycle',
    resource: {}
});

describe('black-box conformance QoS policy', () => {
    // The rtc overlay declares receiver (S2c-ii), so every strategy settles the receiver send on its first carrier.
    it.each(
        [
            { strategy: 'ws', legs: ['ws'], outcome: { carrier: 'ws', verdict: ADMITTED } },
            { strategy: 'rtc', legs: ['rtc'], outcome: { carrier: 'rtc', verdict: ADMITTED } },
            { strategy: 'rtc-with-ws-fallback', legs: ['rtc', 'ws'], outcome: { carrier: 'rtc', verdict: ADMITTED } }
        ] as const
    )('keeps receiver on the $strategy room send and settles it on the carrier that supports it', ({ legs, outcome }) => {
        const message = { ...roomSend, delivery: { reliability: 'at-least-once', ack: 'receiver' } } as const;
        const admissions = legs.map((carrier) => toLegAdmission(message, carrier));
        const settled = admissions.find((admission, index) =>
            index === admissions.length - 1 || computeFallbackDisposition(admission.verdict, undefined, 0) !== 'retry'
        );

        expect(admissions.map((admission) => admission.algo)).toEqual(legs.map(() => 'receiver'));
        expect(settled && { carrier: settled.carrier, verdict: settled.verdict }).toEqual(outcome);
    });
});

const ADMITTED = { kind: 'admitted', durable: false, queuedAttempts: 1 } as const;

/** One carrier leg's admission of the send: its normalized ack algorithm and the verdict its ack support gives. */
function toLegAdmission(message: ALMessage, carrier: ALDeliveryCarrier) {
    const policy = normalizeALQosPolicy(message, toCarrierNormalizationInput(message, carrier));
    const verdict = computeALOutboundAckRefusal({ msg: message, carrier, policy }).fold<ALDeliveryAdmissionVerdict>(
        (refusal) => ({ kind: 'refused', reason: 'unsupported', detail: refusal.dropReason ?? '' }),
        () => ADMITTED
    );
    return { carrier, algo: policy.effective.ack.algo, verdict };
}

/** Both carriers declare receiver: each composition root installs its carrier capabilities under the application provider. */
function toCarrierNormalizationInput(message: ALMessage, carrier: ALDeliveryCarrier) {
    const capabilities = carrier === 'ws' ? AL_WS_CLIENT_CAPABILITIES : AL_RTC_OVERLAY_CAPABILITIES;
    return resolveALQosNormalizationInput(message, { direction: 'outbound' }, toALCarrierQosInputProvider(capabilities, undefined));
}
