import { AL_CONTROL_ACK_TYPE_ID } from '@shared/al-contracts/al-control.ts';
import {
    createPassThroughTransportFaultPort,
    createScriptedTransportFaultPort
} from '@shared/transport-faults/transport-fault-port.ts';
import { describe, expect, it } from 'vitest';

const ackFrame = JSON.stringify({
    id: { v: 2, msgId: 'ctl-1', senderId: 'b', ts: 1 },
    typeId: AL_CONTROL_ACK_TYPE_ID,
    payload: { ackedMsgId: 'msg-1', fromPeerId: 'b', toPeerId: 'a' }
});
const dataFrame = JSON.stringify({
    id: { v: 2, msgId: 'msg-1', senderId: 'a', ts: 1 },
    typeId: 'chat',
    payload: {}
});

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
});
