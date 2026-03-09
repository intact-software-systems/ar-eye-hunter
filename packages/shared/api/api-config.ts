export type ApiConfig = {
    readonly apiBaseUrl: string;
    readonly wsBaseUrl: string;
    readonly endpoints: {
        readonly createWs: string;
    };
};

export enum AppTopics {
    chat = "chat",
    rtcSignaling = "rtc-signaling",
    client = "client",
    clients = "clients",
    rooms = "rooms",
}

export const allTopicIds = new Set(Object.values(AppTopics).map(v => v.toString()));


// TODO: Add version and timestamps on every shared message type
// TODO: Conflict free replicated data types, how to model?

export type ClientData = {
    readonly clientId: string;
    readonly sessionId: string;
    readonly isOnline: boolean;
}

export type IceConfig = {
    readonly iceServers: readonly RTCIceServer[];
    readonly expiresAtEpochMs: number;
};

export type LoginRequest = {
    username: string;
    password: string;
};

export type LoginResponse = {
    clientId: string;
    accessToken: string;
    username: string;
    sessionId: string;
};


export type RoomCreate = {
    name: string
    createdBy: string
};

export type RoomDetails = {
    name: string
    createdBy: string
    createdAtEpochMs: number
    members: readonly string[]
};