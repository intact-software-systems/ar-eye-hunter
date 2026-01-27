import { P2pRole, P2pSignalType, type P2pSessionId, type P2pToken } from "./p2p.ts";

export enum WsChannel {
    ServerGame = "ServerGame",
    P2pSignal = "P2pSignal",
}

export enum P2pWsClientMsgType {
    Hello = "Hello",
    Signal = "Signal",
}

export enum P2pWsServerMsgType {
    Welcome = "Welcome",
    Signal = "Signal",
    Error = "Error",
}

export type P2pWsClientMessage =
    | {
    channel: WsChannel.P2pSignal;
    type: P2pWsClientMsgType.Hello;
    sessionId: P2pSessionId;
    token: P2pToken;
}
    | {
    channel: WsChannel.P2pSignal;
    type: P2pWsClientMsgType.Signal;
    sessionId: P2pSessionId;
    token: P2pToken;
    signalType: P2pSignalType;
    payload: unknown;
};

export type P2pWsServerMessage =
    | {
    channel: WsChannel.P2pSignal;
    type: P2pWsServerMsgType.Welcome;
    sessionId: P2pSessionId;
    role: P2pRole;
}
    | {
    channel: WsChannel.P2pSignal;
    type: P2pWsServerMsgType.Signal;
    sessionId: P2pSessionId;
    fromRole: P2pRole;
    signalType: P2pSignalType;
    payload: unknown;
}
    | {
    channel: WsChannel.P2pSignal;
    type: P2pWsServerMsgType.Error;
    sessionId: P2pSessionId;
    message: string;
};