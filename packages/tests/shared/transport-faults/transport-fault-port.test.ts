import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import {
    createPassThroughTransportFaultPort,
    createScriptedTransportFaultPort
} from '@shared/transport-faults/transport-fault-port.ts';
import { describe, expect, it } from 'vitest';

/** Both carriers put `JSON.stringify(ALMessage)` on the wire, so the frames here are built, not hand-written. */
const ackFrame = JSON.stringify(newALAckControlMessage(
    { v: 2, msgId: 'ctl-1', senderId: 'b', ts: 1 },
    {
        ackedMsgId: 'msg-1',
        fromPeerId: 'b',
        toPeerId: 'a',
        status: 'delivered',
        observedAtEpochMs: 1
    }
));
const dataFrame = JSON.stringify(newALUntargetedMessage(
    'a',
    newALRoute('room.chat', 'room-1', 'resource-1'),
    'chat',
    { text: 'hello' }
));

describe('transport fault port', () => {
    it('passes everything through by default', () => {
        const port = createPassThroughTransportFaultPort();
        expect(port.decideSend('ws', ackFrame)).toEqual({ kind: 'pass' });
    });

    it('drops a matching ACK the configured number of times and records it', () => {
        const port = createScriptedTransportFaultPort();
        port.inject({
            faultId: 'drop-ack',
            carrier: 'ws',
            match: { controlType: 'ack', typeId: undefined, msgId: 'msg-1' },
            action: 'drop',
            remaining: 1
        });

        expect(port.decideSend('ws', ackFrame)).toEqual({ kind: 'drop', faultId: 'drop-ack' });
        expect(port.decideSend('ws', ackFrame)).toEqual({ kind: 'pass' });
        expect(port.decideSend('rtc', ackFrame)).toEqual({ kind: 'pass' });
        expect(port.getObservations()).toEqual([{
            faultId: 'drop-ack',
            carrier: 'ws',
            decision: 'drop'
        }]);
    });

    it('delays a matching data message and ignores non-JSON frames', () => {
        const port = createScriptedTransportFaultPort();
        port.inject({
            faultId: 'slow-chat',
            carrier: 'rtc',
            match: { controlType: undefined, typeId: 'chat', msgId: undefined },
            action: { delayMs: 250 },
            remaining: 2
        });

        expect(port.decideSend('rtc', dataFrame)).toEqual({
            kind: 'delay',
            faultId: 'slow-chat',
            delayMs: 250
        });
        expect(port.decideSend('rtc', 'not json')).toEqual({ kind: 'pass' });
        port.clear();
        expect(port.decideSend('rtc', dataFrame)).toEqual({ kind: 'pass' });
    });

    it('matches an envelope typeId that a frame carries under its payload', () => {
        const port = createScriptedTransportFaultPort();
        port.inject({
            faultId: 'drop-chat',
            carrier: 'rtc',
            match: { controlType: undefined, typeId: 'chat', msgId: undefined },
            action: 'drop',
            remaining: 1
        });

        // A top-level typeId is not the AL wire shape and must never match.
        expect(port.decideSend('rtc', JSON.stringify({ id: { msgId: 'm' }, typeId: 'chat' })))
            .toEqual({ kind: 'pass' });
        expect(port.decideSend('rtc', dataFrame)).toEqual({ kind: 'drop', faultId: 'drop-chat' });
    });
});
