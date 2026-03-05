export enum RoomUiStatus {
    Idle = 'Idle',
    Loading = 'Loading',
    Ready = 'Ready',
    Error = 'Error',
}

export type RoomSummary = {
    readonly roomId: string;
    readonly name: string;
    readonly memberCount: number;
};

export type RoomMember = {
    readonly clientId: string;
    readonly username: string;
    readonly isOwner: boolean;
    readonly isOnline: boolean;
};

export type RoomUiState = {
    readonly status: RoomUiStatus;
    readonly rooms: readonly RoomSummary[];
    readonly selectedRoomId: string; // use 'NA' if none
    readonly selectedRoomName: string;
    readonly members: readonly RoomMember[];
    readonly message: string;
};

export const NA = 'NA';
