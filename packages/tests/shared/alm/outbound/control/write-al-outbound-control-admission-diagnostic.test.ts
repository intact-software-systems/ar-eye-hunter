import { describe, expect, it } from 'vitest';

import { newALRoute, newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    newALAckControlMessage,
    newALNackControlMessage,
    parseALControlMessage
} from '@shared/al-contracts/al-control.ts';
import type { ALOutboundRuntimeDiagnosticsEvent } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { writeALOutboundControlAdmissionDiagnostic } from '@shared/alm/outbound/control/write-al-outbound-control-admission-diagnostic.ts';

import { toTestALAckPayload, toTestALNackPayload } from '../../../../al-control-test-payloads.ts';

const CONTROL_ID = newALUnicastMessage('b', newALRoute('control', 'room-1', 'nack'), 'a', 'chat.v1', {}).id;

/** The event the origin states for one admitted control, as its diagnostics sink receives it. */
function writeAdmitted(control: ALMessage): ALOutboundRuntimeDiagnosticsEvent {
    const events: ALOutboundRuntimeDiagnosticsEvent[] = [];
    writeALOutboundControlAdmissionDiagnostic((event) => events.push(event), {
        control,
        parsed: parseALControlMessage(control)!,
        admitted: { kind: 'committed' }
    });
    return events[0]!;
}

describe('the control-admission event of a NACK', () => {
    it('names the NACK\'s reason and the track it asks about, after the verdict and before the trace', () => {
        const nack = newALNackControlMessage(
            CONTROL_ID,
            toTestALNackPayload({
                msgId: 'sent-3',
                fromPeerId: 'b',
                toPeerId: 'a',
                logicalRecipientPeerId: 'b',
                reason: 'gap',
                observedAtEpochMs: 1,
                orderingKey: 'chat:a:0',
                expectedSeq: 2,
                missingRanges: [{ from: 2, to: 2 }]
            })
        );

        expect(JSON.stringify(writeAdmitted(nack))).toContain(
            '"typeId":"al.control.nack.v2","targetMsgId":"sent-3","outcome":"committed","reason":"none",' +
                '"nackReason":"gap","nackOrderingKey":"chat:a:0","traceId":'
        );
    });

    it('names the reason alone for a NACK about no track', () => {
        const nack = newALNackControlMessage(
            CONTROL_ID,
            toTestALNackPayload({
                msgId: 'sent-3',
                fromPeerId: 'b',
                toPeerId: 'a',
                logicalRecipientPeerId: 'b',
                reason: 'not-subscribed',
                observedAtEpochMs: 1
            })
        );

        expect(writeAdmitted(nack)).toMatchObject({ nackReason: 'not-subscribed' });
        expect(writeAdmitted(nack)).not.toHaveProperty('nackOrderingKey');
    });

    it('states neither field for a control that is no NACK', () => {
        const ack = newALAckControlMessage(
            CONTROL_ID,
            toTestALAckPayload({
                ackedMsgId: 'sent-3',
                fromPeerId: 'b',
                toPeerId: 'a',
                originPeerId: 'a',
                logicalRecipientPeerId: 'b',
                carrier: 'rtc',
                status: 'delivered',
                observedAtEpochMs: 1
            })
        );

        expect(Object.keys(writeAdmitted(ack))).not.toContain('nackReason');
    });
});
