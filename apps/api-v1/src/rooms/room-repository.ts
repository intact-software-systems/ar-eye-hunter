import {RoomCreate, RoomDetails} from "@shared/api/api-config.ts";
import {getKv, toRoomKey, toRoomsPrefix} from "../utils/kv.ts";

export async function putRoomIfAbsent(room: RoomCreate): Promise<RoomDetails> {
    const db = await getKv()

    const roomKey = toRoomKey(room.name)

    {
        const existingRoom = await db.get<RoomDetails>(roomKey);
        if (existingRoom.value !== null) {
            return existingRoom.value as RoomDetails
        }
    }

    const roomDetails: RoomDetails = {
        name: room.name,
        createdAtEpochMs: Date.now(),
        createdBy: room.createdBy,
        members: [room.createdBy]
    }

    await db.set(roomKey, roomDetails)

    return roomDetails
}

export async function listRooms(): Promise<RoomDetails[]> {
    const db = await getKv()

    const entries = db.list(toRoomsPrefix())

    const rooms: RoomDetails[] = []
    for await (const entry of entries) {
        rooms.push(entry.value as RoomDetails)
    }

    return rooms
}

export async function findRoom(roomName: string): Promise<RoomDetails | null> {
    const db = await getKv()

    const entry = await findRoomKV(db, roomName);

    return entry.value
}

async function findRoomKV(db: Deno.Kv, roomName: string) {
    const roomKey = toRoomKey(roomName)

    return await db.get<RoomDetails>(roomKey);
}

export async function joinRoom(roomName: string, clientId: string): Promise<RoomDetails> {
    const db = await getKv()

    const entry = await findRoomKV(db, roomName);
    if (entry.value === null) {
        return Promise.reject("Room not found")
    }

    const existingRoom = entry.value;

    const updatedRoom: RoomDetails = {
        ...existingRoom,
        members: [...new Set([...existingRoom.members, clientId])]
    }

    const commit =
        await db.atomic()
            .check({key: toRoomKey(roomName), versionstamp: entry.versionstamp})
            .set(toRoomKey(roomName), updatedRoom)
            .commit()

    if (!commit.ok) {
        return Promise.reject("Failed to join room")
    }

    return updatedRoom
}

export async function leaveRoom(roomName: string, clientId: string): Promise<RoomDetails> {
    const db = await getKv()

    const entry = await findRoomKV(db, roomName);
    if (entry.value === null) {
        return Promise.reject("Room not found")
    }

    const existingRoom = entry.value;

    const updatedRoom = {
        ...existingRoom,
        members: existingRoom.members.filter(m => m !== clientId)
    }

    const commit =
        await db.atomic()
            .check({key: toRoomKey(roomName), versionstamp: entry.versionstamp})
            .set(toRoomKey(roomName), updatedRoom)
            .commit()

    if (!commit.ok) {
        return Promise.reject("Failed to leave room")
    }

    return updatedRoom
}