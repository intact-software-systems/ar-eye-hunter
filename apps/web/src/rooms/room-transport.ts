import { RoomMember, RoomSummary, RoomUiState, RoomUiStatus } from './room-ui-types.ts';
import * as roomApi from '../middleware/api-integration.ts'
import { addWebSocketInboxCallback } from "../middleware/ws-message-router.ts";
import { AppTopics, RoomDetails } from "@shared/api/api-config.ts";
import { ALPayload } from "@shared/al-contracts/al-contract.ts";
import { ApiMiddleware } from "../app-context.ts";
import { WebRtcQueueBoxClientService } from "@shared/services/WebRtcQueueBoxClientService.ts";
import * as roomsRepository from "../repository/rooms-repository.ts";

export function createRoomDriverWs(mw: ApiMiddleware): RoomDriver {
    const roomTransport = new RoomTransport(mw.middleware.webRtcQueueBox, mw.session.sessionId);
    roomTransport.addRooms(roomsRepository.getAllRoomData())

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
    public leftRoom: RoomDetails | undefined = undefined;
    public sink: (state: RoomUiState) => void;

    constructor(
        public readonly webRtcQueueBox: WebRtcQueueBoxClientService,
        public readonly sessionId: string
    ) {
        this.sink = _ => {
            console.log('RoomTransport sink not set');
        };
    }

    addRooms(rooms: RoomDetails[]) {
        for (const room of rooms) {
            this.roomDataById.set(room.name, room);
        }
    }

    setStateSink(sink: (state: RoomUiState) => void): void {
        this.sink = sink;
    }

    sinkToUi(roomIsUpdated: boolean = false): void {
        if (roomIsUpdated) {
            console.log('RoomTransport sinkToUi called with roomIsUpdated=true');

            if (this.selectedRoom !== undefined) {
                for (const memberId of this.selectedRoom.members) {
                    if (memberId === this.sessionId) {
                        continue;
                    }

                    this.webRtcQueueBox.connectToPeerIfAbsent(memberId)
                        .then(
                            () => console.log(`Connecting to peer ${memberId}`)
                        )
                        .catch(
                            e => console.error(`Failed to connect to peer ${memberId}: ${e}`)
                        )
                }
            }
            if (this.leftRoom !== undefined) {
                for (const memberId of this.leftRoom.members) {
                    if (memberId === this.sessionId) {
                        continue;
                    }
                    console.log(`TODO implement disconnect from peer ${memberId}`)
                }
            }
        }

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

        return selectedRoom.members
            .map(memberId =>
                ({
                    clientId: memberId,
                    username: memberId,
                    isOwner: memberId === selectedRoom.createdBy,
                    isOnline: true,
                })
            );
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
                    this.leftRoom = this.selectedRoom;
                    this.selectedRoom = undefined;
                    this.sinkToUi(true)
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
                    this.leftRoom = this.selectedRoom;
                    this.selectedRoom = room;
                    this.sinkToUi(true)
                }
            )
    }

    createRoom(name: string): Promise<void> {
        return roomApi.createRoom({
                name: name,
                createdBy: this.sessionId
            })
            .then(room => {
                this.leftRoom = this.selectedRoom;
                this.selectedRoom = room;
                this.sinkToUi(true)
            })
    }

    listRooms(): Promise<void> {
        return roomApi.listRooms()
            .then(rooms => {
                for (const room of rooms) {
                    this.roomDataById.set(room.name, room);

                    if (room.members.includes(this.sessionId)) {
                        this.selectedRoom = room;
                    }
                }

                this.sinkToUi()
            })
    }
}

