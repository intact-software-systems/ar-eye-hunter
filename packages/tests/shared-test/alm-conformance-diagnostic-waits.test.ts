import { describe, expect, it } from 'vitest';

import {
    ALM_OUTBOUND_DIAGNOSTICS_TOPIC,
    toControlProofRefusalWait
} from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-diagnostic-waits.ts';
import type { AlmConformanceMessageStepInput } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts';

import { CONFORMANCE_PRINCIPAL_IDS, toConformanceInput } from './alm-conformance-test-input.ts';

function toSenderStep(): AlmConformanceMessageStepInput {
    return {
        input: toConformanceInput('rtc'),
        scenarioId: 'receipted-audience',
        scenarioKey: 'k',
        role: 'sender',
        roles: Object.keys(CONFORMANCE_PRINCIPAL_IDS) as AlmConformanceMessageStepInput['roles'],
        messageSelector: undefined,
        connect: undefined,
        index: 1
    } as AlmConformanceMessageStepInput;
}

describe('toControlProofRefusalWait', () => {
    it('matches an origin\'s proof refusal of one raw control by its authored msgId up to the reason, and by its refusal kind', () => {
        const command = toControlProofRefusalWait({
            step: toSenderStep(),
            name: 'proof-refused',
            controlMsgId: 'forged-{resultCache.alm-rtc-k-sender-send-1.value.msgId}',
            controlTypeId: 'al.control.ack.v3',
            proofRefusal: 'invalid-signature'
        });

        expect(command).toEqual({
            kind: 'wait',
            commandId: 'alm-rtc-k-sender-proof-refused',
            match: {
                kind: 'diagnostic',
                topic: ALM_OUTBOUND_DIAGNOSTICS_TOPIC,
                payloadPath: 'data',
                contains: '"msgId":"forged-{resultCache.alm-rtc-k-sender-send-1.value.msgId}","typeId":"al.control.ack.v3",' +
                    '"targetMsgId":"{resultCache.alm-rtc-k-sender-send-1.value.msgId}","outcome":"rejected","reason":"',
                payloadFields: { 'data.kind': 'control-admission', 'data.proofRefusal': 'invalid-signature' }
            },
            timeoutMs: 18_000 + 10_000 - 1_000
        });
    });
});
