import { ROOM_SEND_CELL_CONSTANTS } from './room-send-cell-constants.ts';
import type { RoomSendShape } from './validate-room-send-shape.ts';

/** One session of the room and the instance its socket is on. */
export interface RoomSendScheduledSession {
    /**
     * The session's one id, as its peer id and its connection's id: `session-04-a` is the fourth session, on instance
     * a. It is the same in every run, so two runs stay apart only through their store namespace or their database.
     */
    readonly peerId: string;
    /** 0 for instance a, 1 for b, 2 for c. The sessions go round the instances in turn. */
    readonly instanceIndex: number;
    /** Every session reads the sends of the others. A `publisher` also offers a track of its own. */
    readonly role: 'publisher' | 'recipient';
    /**
     * How long after it first read a copy the session offers its ACK of it. The session's place in the room fixes it
     * inside the ACK spread, as a whole millisecond.
     */
    readonly ackOffsetMs: number;
}

/** One send, as its publisher is to offer it. */
export interface RoomSendScheduledSend {
    /** The publisher's peer id and the send's place on its track: `session-04-a-send-7`. No two sends share one. */
    readonly msgId: string;
    readonly publisherPeerId: string;
    /** The instance the publisher's socket is on: the one the send is offered to. */
    readonly publisherInstanceIndex: number;
    /** The send's place on its publisher's track, from 1. */
    readonly seq: number;
    /** When the send falls due, in unrounded milliseconds from the start of the send window. */
    readonly dueOffsetMs: number;
    /** Every session of the room but the publisher, in the order of the sessions. */
    readonly expectedRecipientPeerIds: readonly string[];
}

/**
 * Who is in the room and what each publisher offers when. `sends` is in the order the sends fall due, and no two
 * fall due at the same instant.
 */
export interface RoomSendSchedule {
    readonly sessions: readonly RoomSendScheduledSession[];
    readonly sends: readonly RoomSendScheduledSend[];
}

const MS_PER_SECOND = 1_000;

/**
 * The schedule of a shape `validateRoomSendShape` finds no issue in. The publishers are the first sessions of the
 * room, so they go round the instances as the sessions do. Each publisher sends at the shape's rate from the start of
 * the window, and the publishers are staggered evenly inside one period: the window is cut into one slot for each
 * send, and the publishers take the slots in turn, so no two sends ever share a tick.
 */
export function computeRoomSendSchedule(shape: RoomSendShape): RoomSendSchedule {
    const sessions = Array.from(
        { length: ROOM_SEND_CELL_CONSTANTS.sessionCount },
        (_, sessionIndex) => toScheduledSession(sessionIndex, shape.publishers)
    );
    const roomPeerIds = sessions.map(({ peerId }) => peerId);
    const tracks = sessions.slice(0, shape.publishers).map((publisher) => ({
        publisherPeerId: publisher.peerId,
        publisherInstanceIndex: publisher.instanceIndex,
        expectedRecipientPeerIds: roomPeerIds.filter((peerId) => peerId !== publisher.peerId)
    }));
    const slotsPerSecond = shape.sendsPerSecond * shape.publishers;
    const sends = Array.from({ length: shape.sendsPerSecond * shape.durationS * shape.publishers }, (_, slot) => {
        const seq = Math.floor(slot / shape.publishers) + 1;
        const track = tracks[slot % shape.publishers];
        return {
            msgId: `${track.publisherPeerId}-send-${seq}`,
            publisherPeerId: track.publisherPeerId,
            publisherInstanceIndex: track.publisherInstanceIndex,
            seq,
            // Each slot is placed from the window's start, never from the slot before it, so no error adds up.
            dueOffsetMs: (slot * MS_PER_SECOND) / slotsPerSecond,
            expectedRecipientPeerIds: track.expectedRecipientPeerIds
        };
    });
    return { sessions, sends };
}

function toScheduledSession(sessionIndex: number, publishers: number): RoomSendScheduledSession {
    const { sessionCount, instanceCount, ackSpreadMs } = ROOM_SEND_CELL_CONSTANTS;
    const instanceIndex = sessionIndex % instanceCount;
    const instanceLetter = String.fromCharCode('a'.charCodeAt(0) + instanceIndex);
    return {
        peerId: `session-${String(sessionIndex + 1).padStart(2, '0')}-${instanceLetter}`,
        instanceIndex,
        role: sessionIndex < publishers ? 'publisher' : 'recipient',
        ackOffsetMs: Math.floor((sessionIndex * ackSpreadMs) / sessionCount)
    };
}
