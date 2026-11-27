import { describe, expect, it } from 'vitest';

import { decodeALControlMessage } from '@shared/al-contracts/al-control.ts';

import { toRoomSendAck } from '../../../../../apps/api-v1/scripts/perf/alm-room-send/to-room-send-ack.ts';
import { toRoomSendMessage } from '../../../../../apps/api-v1/scripts/perf/alm-room-send/to-room-send-message.ts';

const ROOM = { applicationId: 'room-send-cell', workspaceId: 'default', groupId: 'room-run-1' };

describe('toRoomSendAck', () => {
    it('acknowledges the copy to its publisher as delivered to the recipient that read it, on the WS carrier', () => {
        const copy = toRoomSendMessage({
            send: {
                msgId: 'session-01-a-send-3',
                publisherPeerId: 'session-01-a',
                publisherInstanceIndex: 0,
                seq: 3,
                dueOffsetMs: 1_000,
                expectedRecipientPeerIds: ['session-02-b']
            },
            roomRef: ROOM,
            createdAtEpochMs: 1_800_000_000_000,
            ordering: 'ordering-key'
        });

        const ack = toRoomSendAck({ copy, recipientPeerId: 'session-02-b', observedAtEpochMs: 1_800_000_000_040 });

        expect(ack.id).toEqual({
            v: 4,
            msgId: 'session-02-b-ack-session-01-a-send-3',
            senderId: 'session-02-b',
            ts: 1_800_000_000_040,
            traceId: copy.id.traceId
        });
        expect(decodeALControlMessage(ack).right).toEqual({
            type: 'ack',
            payload: {
                ackedMsgId: 'session-01-a-send-3',
                fromPeerId: 'session-02-b',
                toPeerId: 'session-01-a',
                originPeerId: 'session-01-a',
                logicalRecipientPeerId: 'session-02-b',
                carrier: 'ws',
                status: 'delivered',
                observedAtEpochMs: 1_800_000_000_040,
                proof: null
            }
        });
    });
});
