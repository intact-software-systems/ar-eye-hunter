import { RoomDetails } from "@shared/api/api-config.ts";

const roomDataById = new Map<string, RoomDetails>();

export function getRoomDataById(id: string): RoomDetails | undefined {
    return roomDataById.get(id);
}

export function setRoomDataById(id: string, data: RoomDetails): void {
    roomDataById.set(id, data);
}

export function getAllRoomData(): RoomDetails[] {
    return Array.from(roomDataById.values());
}
