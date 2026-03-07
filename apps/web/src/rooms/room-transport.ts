import {RoomMember, RoomSummary, RoomUiState, RoomUiStatus} from './room-ui-types.ts';
import * as roomApi from '../middleware/api-integration.ts'
import {addWebSocketInboxCallback} from "../middleware/ws-message-router.ts";
import {AppTopics, RoomDetails} from "@shared/api/api-config.ts";
import {ALPayload} from "@shared/al-contracts/al-contract.ts";
import {cachedRoomDataById} from "../middleware/data-caches.ts";

export function createRoomDriverWs(sessionId: string): RoomDriver {
    const roomTransport = new RoomTransport(sessionId);
    roomTransport.addRooms(cachedRoomDataById)

    addWebSocketInboxCallback(
        AppTopics.rooms,
        (payload: ALPayload) => {
            const roomDetails = JSON.parse(payload.resource) as RoomDetails
            console.log(`Received message: ` + JSON.stringify(roomDetails));

            roomTransport.roomDataById.set(roomDetails.name, roomDetails);
            roomTransport.sinkToUi()

            return Promise.resolve();
        }
    )

    return roomTransport;
}

export interface RoomDriver {
    /** UI registers a single state callback. Driver pushes state updates. */
    setStateSink(sink: (state: RoomUiState) => void): void;

    /** list rooms */
    listRooms(): Promise<void>;

    /** create a room by name */
    createRoom(name: string): Promise<void>;

    /** join an existing room */
    joinRoom(roomId: string): Promise<void>;

    /** leave current room */
    leaveRoom(): Promise<void>;

    /** cleanup (close sockets etc.) */
    dispose(): void;
}

class RoomTransport implements RoomDriver {
    public roomDataById = new Map<string, RoomDetails>();

    public selectedRoom: RoomDetails | undefined = undefined;
    public sink: (state: RoomUiState) => void;

    constructor(
        public readonly sessionId: string
    ) {
        this.sink = _ => {
            console.log('RoomTransport sink not set');
        };
    }

    addRooms(roomDataById: Map<string, RoomDetails>) {
        for (const room of roomDataById.values()) {
            this.roomDataById.set(room.name, room);
        }
    }

    setStateSink(sink: (state: RoomUiState) => void): void {
        this.sink = sink;
    }

    sinkToUi(): void {
        this.sink({
            status: RoomUiStatus.Ready,
            rooms: this.toRooms(this.roomDataById),
            selectedRoomId: this.selectedRoom?.name || 'NA',
            selectedRoomName: this.selectedRoom?.name || 'NA',
            members: this.toRoomMembers(this.selectedRoom),
            message: 'Ready'
        });
    }

    private toRooms(roomDataById: Map<string, RoomDetails>): RoomSummary[] {
        const rooms: RoomSummary[] = [];

        for (const room of roomDataById.values()) {
            rooms.push({
                roomId: room.name,
                name: room.name,
                memberCount: room.members.length
            });
        }

        return rooms;
    }

    private toRoomMembers(selectedRoom: RoomDetails | undefined): RoomMember[] {
        if (!selectedRoom) {
            return [];
        }

        return selectedRoom.members.map((memberId) => ({
            clientId: memberId,
            username: memberId,
            isOwner: memberId === selectedRoom.createdBy,
            isOnline: true,
        }));
    }


    dispose(): void {
        console.log('RoomTransport disposed called but not implemented');
    }

    leaveRoom(): Promise<void> {
        if (this.selectedRoom === undefined) {
            return Promise.resolve();
        }

        return roomApi.leaveRoom(this.selectedRoom.name, this.sessionId)
            .then(
                _ => {
                    this.selectedRoom = undefined;
                    this.sinkToUi()
                }
            )
    }

    joinRoom(roomId: string): Promise<void> {
        return this.leaveRoom()
            .then(
                () => roomApi.joinRoom(roomId, this.sessionId)
            )
            .then(
                room => {
                    this.selectedRoom = room;
                    this.sinkToUi()
                }
            )
    }

    createRoom(name: string): Promise<void> {
        return roomApi.createRoom({
                name: name,
                createdBy: this.sessionId
            })
            .then(room => {
                this.selectedRoom = room;
                this.sinkToUi()
            })
    }

    listRooms(): Promise<void> {
        return roomApi.listRooms()
            .then(rooms => {
                for (const room of rooms) {
                    this.roomDataById.set(room.name, room);
                }

                this.sinkToUi()
            })
    }
}

