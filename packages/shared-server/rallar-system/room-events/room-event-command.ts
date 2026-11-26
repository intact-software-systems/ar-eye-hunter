import type { GroupRef } from '@shared/api/group-types.ts';
import type { RoomEvent } from '@shared/api/room-events/room-event.ts';
import { decodeRoomEventCommand } from '@shared/api/room-events/decode-room-event.ts';
import { requireExactOptionalKeys, requireRecord, requireString } from '@shared/api/exact-object-decoding.ts';
import { decodeExactGroupRef } from '@shared/encoding/decode-exact-group-ref.ts';
import { assertGuestTransport, type GroupGuestAdmission } from '../group-state/mutation/membership/group-guest-admission.ts';

export interface RoomEventActor {
    readonly principalId: string;
    readonly sessionId: string;
}

export interface RoomEventMutation extends RoomEventActor {
    readonly lobby: GroupRef;
    readonly requestId: string;
    readonly command: RoomEvent.Command;
    readonly courtTransport?: GroupGuestAdmission.Transport;
}

export function decodeRoomEventMutation(value: unknown): RoomEventMutation {
    const row = requireRecord(value, 'Event mutation');
    requireExactOptionalKeys({ value: row, required: ['lobby', 'requestId', 'principalId', 'sessionId', 'command'],
        optional: ['courtTransport'], label: 'Event mutation' });
    requireString(row.requestId, 'Request identity');
    requireString(row.principalId, 'Principal identity');
    requireString(row.sessionId, 'Session identity');
    const command = decodeRoomEventCommand(row.command);
    if (command.action === 'settle') throw new TypeError('Only the deadline worker can settle an event.');
    const actor = { lobby: decodeExactGroupRef(row.lobby, 'Event lobby'), requestId: row.requestId, principalId: row.principalId, sessionId: row.sessionId };
    if (row.courtTransport === undefined) return { ...actor, command };
    if (command.action !== 'claim') throw new TypeError('Only a court claim may carry a guest binding.');
    const transport = requireRecord(row.courtTransport, 'Event court guest binding');
    requireString(transport.sessionId, 'Court guest session');
    requireString(transport.accessTokenDigest, 'Court guest verifier');
    const courtTransport = { sessionId: transport.sessionId, accessTokenDigest: transport.accessTokenDigest };
    assertGuestTransport(courtTransport);
    return { ...actor, command, courtTransport };
}
