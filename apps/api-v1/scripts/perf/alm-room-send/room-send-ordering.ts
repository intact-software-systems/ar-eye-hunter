/**
 * Whether a room send names an ordering key. `ordering-key`: it names the room's key at its seq, so it has a place
 * on its publisher's track, and the server reports a gap in that track and a client holds a copy back for an earlier
 * one. `unordered`: it names none, as a browser's room send does unless its caller names a key; it has no track, and
 * nothing puts its copies back in the order they were offered in.
 */
export type RoomSendOrdering = 'ordering-key' | 'unordered';

export const ROOM_SEND_ORDERINGS: readonly RoomSendOrdering[] = ['ordering-key', 'unordered'];
