import type {ClientId} from "../tictactoe/tictactoe-api.ts";

export type P2pSessionId = string;

export enum P2pRole {
    Initiator = 'Initiator',
    Responder = 'Responder',
}

export enum P2pSessionStatus {
    WaitingForPeer = 'WaitingForPeer',
    Active = 'Active',
    Closed = 'Closed',
}

export enum P2pSignalType {
    Offer = 'Offer',
    Answer = 'Answer',
    IceCandidate = 'IceCandidate',
}

export type P2pToken = string;

// We keep signal payload as "unknown JSON". The browser will provide RTCSessionDescriptionInit / RTCIceCandidateInit.
export type P2pSignalPayload = unknown;

export type CreateP2pSessionRequest = {
    clientId: ClientId;
};

export type CreateP2pSessionResponse = {
    sessionId: P2pSessionId;
    role: P2pRole.Initiator;
    token: P2pToken;
    status: P2pSessionStatus;
    expiresAtEpochMs: number;
};

export type JoinP2pSessionRequest = {
    clientId: ClientId;
};

export type JoinP2pSessionResponse = {
    sessionId: P2pSessionId;
    role: P2pRole.Responder;
    token: P2pToken;
    status: P2pSessionStatus;
    expiresAtEpochMs: number;
};

export type PostP2pSignalRequest = {
    token: P2pToken;
    type: P2pSignalType;
    payload: P2pSignalPayload;
};

export type PostP2pSignalResponse = {
    ok: true;
};

export enum P2pCursor {
    NA = '',
}

export type GetP2pSignalsResponse = {
    signals: readonly P2pSignalRecord[];
    nextCursor: string; // '' means no further paging
};

export type P2pSignalRecord = {
    fromRole: P2pRole;
    type: P2pSignalType;
    payload: P2pSignalPayload;
    createdAtEpochMs: number;
};
