/** A room owned by the event lifecycle. Its organizer may enter a court as a player only while assigned. */
export interface RoomEventBinding {
    readonly lobbyGroupId: string;
    readonly organizerPlaying: boolean;
    readonly emptyReturnWindowMs: number;
}

export function validatedRoomEventFields(group: object): readonly string[] {
    if (!('eventRoom' in group)) return [];
    const value = group.eventRoom;
    if (!('kind' in group) || group.kind !== 'room' || !('expiresAtEpochMs' in group) || !Number.isSafeInteger(group.expiresAtEpochMs) ||
        !value || typeof value !== 'object' || Object.keys(value).length !== 3 ||
        !('lobbyGroupId' in value) || typeof value.lobbyGroupId !== 'string' || !value.lobbyGroupId ||
        !('organizerPlaying' in value) || typeof value.organizerPlaying !== 'boolean' ||
        !('emptyReturnWindowMs' in value) || typeof value.emptyReturnWindowMs !== 'number' ||
        !Number.isSafeInteger(value.emptyReturnWindowMs) || value.emptyReturnWindowMs <= 0) {
        throw new TypeError('Invalid event room binding or closing time.');
    }
    return ['eventRoom'];
}

/** The court owner retains its administrative membership while every playing seat is available. */
export function hasOffCourtOrganizer(group: object): boolean {
    if (!('eventRoom' in group) || !('groupId' in group)) return false;
    const eventRoom = group.eventRoom;
    return typeof eventRoom === 'object' && eventRoom !== null && 'lobbyGroupId' in eventRoom &&
        eventRoom.lobbyGroupId !== group.groupId && 'organizerPlaying' in eventRoom && eventRoom.organizerPlaying === false;
}
